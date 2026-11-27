import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile


def build(commit, target):
    if subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != commit:
        raise SystemExit("the requested source is not checked out")
    stem = "infra/aws/customer-zero/workload"
    files = {
        name: subprocess.check_output(["git", "show", f"{commit}:{stem}/{name}"])
        for name in ("application.mjs", "service.mjs")
    }
    target.mkdir(parents=True, exist_ok=True)
    for candidate in ("a", "b"):
        path = target / f"{candidate}.zip"
        release = {"commit": commit, "candidate": candidate}
        payload = dict(files, **{"release.json": json.dumps(release, separators=(",", ":")).encode()})
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
            for name, content in sorted(payload.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, content)
        print(json.dumps({**release, "archive": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    build(sys.argv[1], Path(sys.argv[2]))
