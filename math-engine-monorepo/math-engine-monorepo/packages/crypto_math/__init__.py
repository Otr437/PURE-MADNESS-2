import importlib.util
from pathlib import Path

_pkg_dir = Path(__file__).resolve().parent.parent / "crypto-math"
_spec    = importlib.util.spec_from_file_location("crypto_math_pkg", _pkg_dir / "__init__.py")
_mod     = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

SECP256K1     = _mod.SECP256K1
ECPoint       = _mod.ECPoint
CryptoMathUtils = _mod.CryptoMathUtils
__all__ = ["SECP256K1", "ECPoint", "CryptoMathUtils"]
