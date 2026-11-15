import json
import re
import sys
import xml.etree.ElementTree as ET
import zlib


def main() -> int:
    xml_path = sys.argv[1]
    with open(xml_path, "r", encoding="utf-8") as f:
        raw_xml = f.read()

    root = ET.fromstring(raw_xml)
    items = []
    for elem in root.findall("item"):
        text = re.sub(r"\s+", " ", (elem.text or "").strip())
        items.append({
            "id": int(elem.attrib["id"]),
            "name": text,
            "price": float(elem.attrib["price"]),
        })

    serialized = json.dumps({"items": items}, sort_keys=True).encode("utf-8")
    compressed = zlib.compress(serialized)
    roundtrip = zlib.decompress(compressed)
    assert roundtrip == serialized
    print(roundtrip.decode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
