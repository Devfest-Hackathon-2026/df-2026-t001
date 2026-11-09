import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "api"))


@pytest.fixture(scope="session")
def synth(tmp_path_factory):
    """合成データを一時ディレクトリに生成する（シード固定で毎回同じ）。"""
    out = tmp_path_factory.mktemp("synth")
    subprocess.run([sys.executable, str(ROOT / "scripts/synth/generate.py"), "--out", str(out)], check=True, capture_output=True)
    return out
