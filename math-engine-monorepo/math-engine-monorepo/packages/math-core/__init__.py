"""
math-core — pure mathematics:
Arithmetic, Algebra, Trigonometry, Calculus, LinearAlgebra,
Statistics, Probability, NumberTheory, ComplexAnalysis,
SpecialFunctions, Optimization, DifferentialEquations.
"""

from .arithmetic   import Arithmetic
from .algebra      import Algebra
from .trigonometry import Trigonometry
from .calculus     import Calculus
from .linalg       import LinearAlgebra
from .statistics   import Statistics
from .probability  import Probability
from .numtheory    import NumberTheory
from .complex_ops  import ComplexAnalysis
from .special      import SpecialFunctions
from .optimize     import Optimization
from .diffeq       import DifferentialEquations
from .constants    import MathConstants

__all__ = [
    "Arithmetic", "Algebra", "Trigonometry", "Calculus", "LinearAlgebra",
    "Statistics", "Probability", "NumberTheory", "ComplexAnalysis",
    "SpecialFunctions", "Optimization", "DifferentialEquations", "MathConstants",
]
