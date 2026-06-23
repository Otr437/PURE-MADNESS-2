"""
Alias module: 'god_mode' → 'god-mode' (hyphen-safe Python import).
"""
import importlib.util, sys
from pathlib import Path

_pkg_dir = Path(__file__).resolve().parent.parent / "god-mode"
_spec    = importlib.util.spec_from_file_location("god_mode_pkg", _pkg_dir / "__init__.py")
_mod     = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

GodModeEngine = _mod.GodModeEngine
__all__ = ["GodModeEngine"]
