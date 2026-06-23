import importlib.util
from pathlib import Path

_pkg_dir = Path(__file__).resolve().parent.parent / "math-core"
_spec    = importlib.util.spec_from_file_location("math_core_pkg", _pkg_dir / "__init__.py")
_mod     = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

Arithmetic   = _mod.Arithmetic
Algebra      = _mod.Algebra
Trigonometry = _mod.Trigonometry
Calculus     = _mod.Calculus
LinearAlgebra = _mod.LinearAlgebra
Statistics   = _mod.Statistics
Probability  = _mod.Probability
NumberTheory = _mod.NumberTheory
ComplexAnalysis = _mod.ComplexAnalysis
SpecialFunctions = _mod.SpecialFunctions
Optimization = _mod.Optimization
DifferentialEquations = _mod.DifferentialEquations
MathConstants = _mod.MathConstants
__all__ = [
    "Arithmetic","Algebra","Trigonometry","Calculus","LinearAlgebra",
    "Statistics","Probability","NumberTheory","ComplexAnalysis",
    "SpecialFunctions","Optimization","DifferentialEquations","MathConstants",
]
