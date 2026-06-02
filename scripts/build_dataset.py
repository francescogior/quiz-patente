from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from PIL import Image
from pypdf import PdfReader
from pypdf.generic import ContentStream


ROOT = Path(__file__).resolve().parents[1]
PDF_PATH = ROOT / "data" / "source" / "domande-ab-italiano-2025.pdf"
QUESTIONS_JS = ROOT / "data" / "questions.js"
ASSET_MANIFEST_SW = ROOT / "data" / "asset-manifest-sw.js"
SIGNS_DIR = ROOT / "assets" / "signs"
ICONS_DIR = ROOT / "assets" / "icons"

SOURCE_URL = (
    "https://ilportaledellautomobilista.it/web/portale-automobilista/-/"
    "quiz-per-le-patenti-am-b-superiori-e-cqc"
)
PDF_URL = (
    "https://ilportaledellautomobilista.it/documents/56611/57321/"
    "domande%2BAB%2Bitaliano%2B23%2B04%2B2025/95e60cf5-8e20-444a-87d3-7b51e979e851"
)

QUESTION_START_RE = re.compile(r"^(\d{4,5})\s+(.+)$")
ANSWER_RE = re.compile(r"(VERO|FALSO)\s*$")
TOPIC_RE = re.compile(r"Quesito n.\s*(\d+)\s*-\s*(.+)", re.IGNORECASE)
TABLE_MARKER = "Testo domanda Risposta Corretta Immagine"
VISUAL_REFERENCE_RE = re.compile(r"\b(raffigurat\w*|figura)\b", re.IGNORECASE)
QUESTION_ID_RE = re.compile(r"^\d{4,5}$")
QUESTION_ID_COLUMN_MAX_X = 60
IMAGE_COLUMN_MIN_X = 400
IMAGE_MATCH_MAX_DISTANCE = 100


def clean_line(line: str) -> str:
    return " ".join(line.replace("\xa0", " ").split())


def is_noise(line: str) -> bool:
    if not line:
        return True
    return line in {
        "Numero",
        "domanda",
        TABLE_MARKER,
        "Ministero delle Infrastrutture e dei Trasporti",
    }


def extract_page_topic(lines: list[str]) -> str | None:
    for line in lines:
        match = TOPIC_RE.search(line.replace("°", "."))
        if match:
            return clean_line(match.group(2))
    return None


def parse_questions(lines: list[str], topic: str | None) -> list[dict]:
    rows: list[dict] = []
    current: dict | None = None

    for raw_line in lines:
        line = clean_line(raw_line)
        if is_noise(line) or line.startswith("Quesito n"):
            continue

        start = QUESTION_START_RE.match(line)
        if start:
            current = {
                "id": int(start.group(1)),
                "parts": [],
                "topic": topic or "Quiz ministeriali",
            }
            line = start.group(2)

        if current is None:
            continue

        answer = ANSWER_RE.search(line)
        if answer:
            question_text = line[: answer.start()].strip()
            if question_text:
                current["parts"].append(question_text)

            text = clean_line(" ".join(current["parts"]))
            rows.append(
                {
                    "id": current["id"],
                    "text": text,
                    "correct": answer.group(1) == "VERO",
                    "topic": current["topic"],
                }
            )
            current = None
        elif line in {"VERO", "FALSO"}:
            text = clean_line(" ".join(current["parts"]))
            rows.append(
                {
                    "id": current["id"],
                    "text": text,
                    "correct": line == "VERO",
                    "topic": current["topic"],
                }
            )
            current = None
        else:
            current["parts"].append(line)

    return rows


def image_hash_size_and_format(data: bytes) -> tuple[str, tuple[int, int], str | None]:
    image = Image.open(BytesIO(data))
    return hashlib.sha256(data).hexdigest()[:16], image.size, image.format


def multiply_pdf_matrix(left: list[float], right: list[float]) -> list[float]:
    a, b, c, d, e, f = left
    g, h, i, j, k, l = right
    return [
        a * g + c * h,
        b * g + d * h,
        a * i + c * j,
        b * i + d * j,
        a * k + c * l + e,
        b * k + d * l + f,
    ]


def bbox_from_matrix(matrix: list[float]) -> tuple[float, float, float, float]:
    a, b, c, d, e, f = matrix
    xs = [e, a + e, c + e, a + c + e]
    ys = [f, b + f, d + f, b + d + f]
    return min(xs), min(ys), max(xs), max(ys)


def page_question_y_positions(page) -> dict[int, float]:
    positions: dict[int, float] = {}

    def visitor(text, _cm, tm, _font_dict, _font_size) -> None:
        line = clean_line(str(text))
        if not QUESTION_ID_RE.match(line):
            return

        x = float(tm[4])
        if x <= QUESTION_ID_COLUMN_MAX_X:
            positions[int(line)] = float(tm[5])

    page.extract_text(visitor_text=visitor)
    return positions


def page_image_placements(page, reader: PdfReader, saved_images: dict[str, bytes]) -> list[dict]:
    image_hash_by_name: dict[str, str] = {}
    for image_file_object in page.images:
        data = image_file_object.data
        image_hash, size, image_format = image_hash_size_and_format(data)
        if image_format == "PNG" and size == (106, 119):
            continue
        saved_images.setdefault(image_hash, data)
        image_hash_by_name[Path(image_file_object.name).stem] = image_hash

    if not image_hash_by_name:
        return []

    placements: list[dict] = []
    stack: list[list[float]] = []
    current_matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    content = page.get_contents()
    if content is None:
        return placements

    stream = ContentStream(content, reader)
    for operands, operator in stream.operations:
        if operator == b"q":
            stack.append(current_matrix[:])
        elif operator == b"Q":
            current_matrix = stack.pop() if stack else [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        elif operator == b"cm":
            current_matrix = multiply_pdf_matrix(current_matrix, [float(value) for value in operands])
        elif operator == b"Do":
            image_name = str(operands[0]).lstrip("/")
            image_hash = image_hash_by_name.get(image_name)
            if not image_hash:
                continue

            left, bottom, right, top = bbox_from_matrix(current_matrix)
            if left < IMAGE_COLUMN_MIN_X:
                continue

            placements.append(
                {
                    "hash": image_hash,
                    "center_y": (bottom + top) / 2,
                }
            )

    return placements


def assign_images_by_position(
    page,
    reader: PdfReader,
    rows_by_segment: list[list[dict]],
    saved_images: dict[str, bytes],
) -> list[str]:
    anomalies: list[str] = []
    visual_rows = [row for rows in rows_by_segment for row in rows if row_needs_image(row)]
    if not visual_rows:
        page_image_placements(page, reader, saved_images)
        return anomalies

    question_y_by_id = page_question_y_positions(page)
    placements = page_image_placements(page, reader, saved_images)
    if not placements:
        return anomalies

    for row in visual_rows:
        question_y = question_y_by_id.get(row["id"])
        if question_y is None:
            continue

        closest = min(placements, key=lambda placement: abs(placement["center_y"] - question_y))
        distance = abs(closest["center_y"] - question_y)
        if distance > IMAGE_MATCH_MAX_DISTANCE:
            continue

        row["image"] = f"assets/signs/{closest['hash']}.jpg"

    return anomalies


def page_image_hashes(page, saved_images: dict[str, bytes]) -> list[str]:
    hashes: list[str] = []
    for image_file_object in page.images:
        data = image_file_object.data
        image_hash, size, image_format = image_hash_size_and_format(data)
        if image_format == "PNG" and size == (106, 119):
            continue
        saved_images.setdefault(image_hash, data)
        hashes.append(image_hash)
    return hashes


def choose_single_hash(counter: Counter, count: int, avoid: str | None = None) -> str | None:
    if not count or not counter:
        return None

    exact = [image_hash for image_hash, amount in counter.items() if amount == count]
    if avoid and len(exact) > 1:
        exact = [image_hash for image_hash in exact if image_hash != avoid]
    if exact:
        return exact[0]

    candidates = [image_hash for image_hash, amount in counter.items() if amount >= count]
    if avoid and len(candidates) > 1:
        candidates = [image_hash for image_hash in candidates if image_hash != avoid]
    return candidates[0] if candidates else None


def rows_need_image(rows: list[dict]) -> bool:
    return any(VISUAL_REFERENCE_RE.search(row["text"]) for row in rows)


def row_needs_image(row: dict) -> bool:
    return bool(VISUAL_REFERENCE_RE.search(row["text"]))


def assign_images(
    rows_by_segment: list[list[dict]],
    image_hashes: list[str],
    last_image_hash: str | None,
) -> tuple[str | None, list[str]]:
    remaining_sequence = list(image_hashes)
    anomalies: list[str] = []
    next_hash = last_image_hash

    def remove_assigned(assigned_hashes: list[str]) -> None:
        for assigned_hash in assigned_hashes:
            try:
                remaining_sequence.remove(assigned_hash)
            except ValueError:
                pass

    for segment_index, rows in enumerate(rows_by_segment):
        if not rows:
            continue

        assigned: list[str] = []
        remaining = Counter(remaining_sequence)

        if remaining and segment_index == 0 and last_image_hash in remaining:
            if remaining[last_image_hash] >= len(rows):
                assigned = [last_image_hash] * len(rows)

        if not assigned and remaining:
            if segment_index == 0 and last_image_hash in remaining:
                segment_hash = last_image_hash
            else:
                segment_hash = choose_single_hash(remaining, len(rows), avoid=next_hash)
            if segment_hash:
                assigned = [segment_hash] * len(rows)

        if not assigned and len(remaining_sequence) >= len(rows):
            assigned = remaining_sequence[: len(rows)]

        if not assigned:
            visual_rows = [row for row in rows if row_needs_image(row)]
            if remaining_sequence and len(remaining_sequence) >= len(visual_rows):
                assigned = remaining_sequence[: len(visual_rows)]
                for row, image_hash in zip(visual_rows, assigned):
                    row["image"] = f"assets/signs/{image_hash}.jpg"
                remove_assigned(assigned)
                next_hash = assigned[-1] if assigned else next_hash
                continue

            if image_hashes and rows_need_image(rows):
                anomalies.append(f"missing image for segment {segment_index} with {len(rows)} rows")
            continue

        for row, image_hash in zip(rows, assigned):
            row["image"] = f"assets/signs/{image_hash}.jpg"

        remove_assigned(assigned)
        next_hash = assigned[-1]

    return next_hash, anomalies


def split_page_segments(lines: list[str]) -> list[list[str]]:
    segments: list[list[str]] = [[]]
    for line in lines:
        if line == TABLE_MARKER:
            segments.append([])
            continue
        segments[-1].append(line)
    return segments


def build_questions() -> tuple[list[dict], dict[str, bytes], list[str]]:
    reader = PdfReader(PDF_PATH)
    questions: list[dict] = []
    saved_images: dict[str, bytes] = {}
    anomalies: list[str] = []
    last_topic: str | None = None
    last_image_hash: str | None = None

    for page_index, page in enumerate(reader.pages):
        lines = [clean_line(line) for line in (page.extract_text() or "").splitlines()]
        page_topic = extract_page_topic(lines) or last_topic
        segments = split_page_segments(lines)
        rows_by_segment = [
            parse_questions(segment, last_topic if segment_index == 0 else page_topic)
            for segment_index, segment in enumerate(segments)
        ]

        image_hashes = page_image_hashes(page, saved_images)
        last_image_hash, page_anomalies = assign_images(
            rows_by_segment, image_hashes, last_image_hash
        )
        page_anomalies.extend(
            assign_images_by_position(page, reader, rows_by_segment, saved_images)
        )
        anomalies.extend(f"page {page_index + 1}: {message}" for message in page_anomalies)

        for rows in rows_by_segment:
            questions.extend(rows)

        if page_topic:
            last_topic = page_topic

    deduped: dict[int, dict] = {}
    for question in questions:
        deduped[question["id"]] = question

    usable_questions = [
        question
        for question in deduped.values()
        if not (row_needs_image(question) and "image" not in question)
    ]
    omitted = len(deduped) - len(usable_questions)
    if omitted:
        anomalies.append(f"omitted {omitted} visual questions without a safe image match")

    return usable_questions, saved_images, anomalies


def write_questions_js(questions: list[dict], assets: list[str]) -> None:
    payload = {
        "source": {
            "name": "Portale dell'Automobilista - Patente AB",
            "pageUrl": SOURCE_URL,
            "pdfUrl": PDF_URL,
            "pdfFilename": PDF_PATH.name,
            "officialUpdate": "25-11-2025",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "settings": {
            "examQuestions": 30,
            "examMinutes": 20,
            "maxErrors": 3,
        },
        "questions": questions,
    }

    QUESTIONS_JS.write_text(
        "window.PATENTE_QUESTION_BANK = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )

    ASSET_MANIFEST_SW.write_text(
        "self.PATENTE_ASSETS = "
        + json.dumps(assets, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )


def write_images(saved_images: dict[str, bytes]) -> list[str]:
    SIGNS_DIR.mkdir(parents=True, exist_ok=True)
    assets: list[str] = []
    for image_hash, data in sorted(saved_images.items()):
        path = SIGNS_DIR / f"{image_hash}.jpg"
        path.write_bytes(data)
        assets.append(f"./assets/signs/{image_hash}.jpg")
    return assets


def write_icons() -> list[str]:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    assets: list[str] = []
    for size in (192, 512):
        image = Image.new("RGBA", (size, size), "#0F3D3E")
        draw = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        from PIL import ImageDraw

        d = ImageDraw.Draw(draw)
        pad = int(size * 0.13)
        d.rounded_rectangle(
            [pad, pad, size - pad, size - pad],
            radius=int(size * 0.08),
            fill="#F8FAF5",
            outline="#D1462F",
            width=max(8, int(size * 0.045)),
        )
        d.polygon(
            [
                (size * 0.31, size * 0.38),
                (size * 0.69, size * 0.38),
                (size * 0.50, size * 0.66),
            ],
            fill="#1F6F8B",
        )
        d.rectangle(
            [size * 0.44, size * 0.26, size * 0.56, size * 0.74],
            fill="#1F6F8B",
        )
        image.alpha_composite(draw)
        path = ICONS_DIR / f"icon-{size}.png"
        image.save(path)
        assets.append(f"./assets/icons/icon-{size}.png")
    return assets


def main() -> None:
    if not PDF_PATH.exists():
        raise SystemExit(f"Missing source PDF: {PDF_PATH}")

    questions, saved_images, anomalies = build_questions()
    sign_assets = write_images(saved_images)
    icon_assets = write_icons()
    write_questions_js(questions, sign_assets + icon_assets)

    image_questions = sum(1 for question in questions if "image" in question)
    print(f"questions: {len(questions)}")
    print(f"image questions: {image_questions}")
    print(f"unique sign images: {len(saved_images)}")
    if anomalies:
        print("anomalies:")
        for anomaly in anomalies[:20]:
            print(f"- {anomaly}")
        if len(anomalies) > 20:
            print(f"... {len(anomalies) - 20} more")


if __name__ == "__main__":
    main()
