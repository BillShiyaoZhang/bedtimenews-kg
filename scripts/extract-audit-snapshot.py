"""Extract only bounded data files into a new directory. Never execute content."""
import json
import os
import pathlib
import stat
import sys
import zipfile

NAMES = {"diff.json", "kg.json", "lifecycle.json.gz", "manifest.json", "news.json",
         "provenance.json.gz", "source-review.json", "snapshot.json"}
LIMIT = 129 * 1024 * 1024


def extract(archive, destination):
    target = pathlib.Path(destination)
    if target.parent.resolve() != target.parent.absolute():
        raise ValueError("Redirected output parent")
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) != len(NAMES) or {entry.filename for entry in entries} != NAMES:
            raise ValueError("Unexpected, duplicate or missing snapshot file")
        total = 0
        for entry in entries:
            mode = entry.external_attr >> 16
            cap = 128 * 1024 if entry.filename == "snapshot.json" else LIMIT
            if (entry.is_dir() or entry.flag_bits & 1 or entry.file_size > cap
                    or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    or (stat.S_IFMT(mode) not in (0, stat.S_IFREG))):
                raise ValueError("Unsafe snapshot entry")
            total += entry.file_size
        if total > LIMIT + 128 * 1024:
            raise ValueError("Snapshot exceeds expanded byte budget")
        target.mkdir(mode=0o700)  # Existing destinations are never reused.
        for entry in entries:
            written = 0
            with source.open(entry) as incoming, open(target / entry.filename, "xb") as outgoing:
                os.chmod(target / entry.filename, 0o600)
                while block := incoming.read(min(1024 * 1024, entry.file_size - written + 1)):
                    written += len(block)
                    if written > entry.file_size:
                        raise ValueError("Expanded entry differs from archive header")
                    outgoing.write(block)
            if written != entry.file_size:
                raise ValueError("Truncated snapshot entry")
    print(json.dumps({"files": len(NAMES), "bytes": total}))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise ValueError("Expected archive and new output directory")
    extract(sys.argv[1], sys.argv[2])
