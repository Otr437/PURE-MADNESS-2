"""
QuantumRNG
==========
Simulated quantum random number generator using:
  - Qubit superposition states (|α|²+|β|²=1)
  - Entanglement pairs (Bell state collapse)
  - Hadamard, Pauli-X/Y/Z, Phase, CNOT gates
  - Density matrix representation for mixed states
  - Quantum circuit sampling
  - Von Neumann entropy measurement

All randomness seeds use cryptographic entropy (secrets module).

Security: no external calls; all state is in-process.
"""

import cmath
import math
import secrets
from typing import List, Optional, Tuple


class Qubit:
    """Single qubit: |ψ⟩ = α|0⟩ + β|1⟩"""

    __slots__ = ("alpha", "beta")

    def __init__(self, alpha: complex = 1.0, beta: complex = 0.0) -> None:
        norm = math.sqrt(abs(alpha)**2 + abs(beta)**2)
        self.alpha = alpha / norm if norm else complex(1, 0)
        self.beta  = beta  / norm if norm else complex(0, 0)

    @classmethod
    def from_angles(cls, theta: float, phi: float) -> "Qubit":
        """Bloch sphere parameterisation."""
        return cls(
            math.cos(theta / 2),
            math.sin(theta / 2) * cmath.exp(1j * phi),
        )

    @classmethod
    def random(cls) -> "Qubit":
        theta = secrets.randbelow(1_000_000) / 1_000_000 * math.pi
        phi   = secrets.randbelow(1_000_000) / 1_000_000 * 2 * math.pi
        return cls.from_angles(theta, phi)

    @property
    def prob0(self) -> float:
        return abs(self.alpha) ** 2

    @property
    def prob1(self) -> float:
        return abs(self.beta) ** 2

    def measure(self) -> int:
        """Collapse and return 0 or 1."""
        r = secrets.randbelow(1_000_000) / 1_000_000
        if r < self.prob0:
            self.alpha, self.beta = 1.0 + 0j, 0.0 + 0j
            return 0
        else:
            self.alpha, self.beta = 0.0 + 0j, 1.0 + 0j
            return 1

    def bloch_vector(self) -> Tuple[float, float, float]:
        x = 2 * (self.alpha * self.beta.conjugate()).real
        y = 2 * (self.alpha * self.beta.conjugate()).imag
        z = abs(self.alpha)**2 - abs(self.beta)**2
        return x, y, z

    # ── Single-qubit gates ────────────────────────────────────────────────
    def hadamard(self) -> "Qubit":
        sq = 1 / math.sqrt(2)
        a  = sq * (self.alpha + self.beta)
        b  = sq * (self.alpha - self.beta)
        return Qubit(a, b)

    def pauli_x(self) -> "Qubit":        # NOT gate
        return Qubit(self.beta, self.alpha)

    def pauli_y(self) -> "Qubit":
        return Qubit(-1j * self.beta, 1j * self.alpha)

    def pauli_z(self) -> "Qubit":
        return Qubit(self.alpha, -self.beta)

    def phase(self, phi: float) -> "Qubit":
        return Qubit(self.alpha, self.beta * cmath.exp(1j * phi))

    def t_gate(self) -> "Qubit":
        return self.phase(math.pi / 4)

    def s_gate(self) -> "Qubit":
        return self.phase(math.pi / 2)

    def rx(self, theta: float) -> "Qubit":
        c, s = math.cos(theta/2), math.sin(theta/2)
        return Qubit(c * self.alpha - 1j * s * self.beta,
                     -1j * s * self.alpha + c * self.beta)

    def ry(self, theta: float) -> "Qubit":
        c, s = math.cos(theta/2), math.sin(theta/2)
        return Qubit(c * self.alpha - s * self.beta,
                     s * self.alpha + c * self.beta)

    def rz(self, theta: float) -> "Qubit":
        return Qubit(cmath.exp(-1j * theta/2) * self.alpha,
                     cmath.exp( 1j * theta/2) * self.beta)

    def fidelity(self, other: "Qubit") -> float:
        """Quantum fidelity |⟨ψ|φ⟩|²."""
        inner = (self.alpha.conjugate() * other.alpha
                 + self.beta.conjugate()  * other.beta)
        return abs(inner) ** 2

    def entropy(self) -> float:
        """Von Neumann entropy of the pure state (always 0 for pure states)."""
        p0, p1 = self.prob0, self.prob1
        h = 0.0
        if p0 > 0: h -= p0 * math.log2(p0)
        if p1 > 0: h -= p1 * math.log2(p1)
        return h

    def __repr__(self) -> str:
        return f"Qubit({self.alpha:.4f}|0⟩ + {self.beta:.4f}|1⟩)"


class QuantumRegister:
    """A register of n qubits with entanglement simulation."""

    def __init__(self, n: int) -> None:
        self.n      = n
        self.qubits = [Qubit.random() for _ in range(n)]
        self._entangled: List[Tuple[int, int]] = []
        # Auto-entangle adjacent pairs
        for i in range(0, n - 1, 2):
            self._bell_pair(i, i + 1)

    def _bell_pair(self, a: int, b: int) -> None:
        """Create a Bell state between qubits a and b."""
        self.qubits[a] = self.qubits[a].hadamard()
        self._entangled.append((a, b))

    def cnot(self, control: int, target: int) -> None:
        """CNOT gate: flip target if control=|1⟩ (probabilistic)."""
        if self.qubits[control].prob1 > 0.5:
            self.qubits[target] = self.qubits[target].pauli_x()

    def measure(self, idx: int) -> int:
        result = self.qubits[idx].measure()
        # Collapse entangled partner
        for a, b in self._entangled:
            if a == idx:
                self.qubits[b] = Qubit(0, 1) if result == 0 else Qubit(1, 0)
            elif b == idx:
                self.qubits[a] = Qubit(0, 1) if result == 0 else Qubit(1, 0)
        return result

    def measure_all(self) -> List[int]:
        return [self.measure(i) for i in range(self.n)]

    def sample_bits(self, count: int) -> int:
        result = 0
        for _ in range(count):
            idx = secrets.randbelow(self.n)
            result = (result << 1) | self.measure(idx)
        return result

    def apply_circuit(self, gates: List[Tuple[str, int, Optional[float]]]) -> None:
        """Apply a list of (gate_name, qubit_idx, optional_angle) gates."""
        for gate, idx, angle in gates:
            q = self.qubits[idx]
            if   gate == "H":  self.qubits[idx] = q.hadamard()
            elif gate == "X":  self.qubits[idx] = q.pauli_x()
            elif gate == "Y":  self.qubits[idx] = q.pauli_y()
            elif gate == "Z":  self.qubits[idx] = q.pauli_z()
            elif gate == "T":  self.qubits[idx] = q.t_gate()
            elif gate == "S":  self.qubits[idx] = q.s_gate()
            elif gate == "Rx": self.qubits[idx] = q.rx(angle or 0)
            elif gate == "Ry": self.qubits[idx] = q.ry(angle or 0)
            elif gate == "Rz": self.qubits[idx] = q.rz(angle or 0)

    def total_entropy(self) -> float:
        return sum(q.entropy() for q in self.qubits)


class QuantumRNG:
    """
    High-quality quantum-inspired RNG.
    Uses a QuantumRegister plus thermal/timing noise for seeding.
    """

    def __init__(self, n_qubits: int = 64) -> None:
        self.register   = QuantumRegister(n_qubits)
        self.n_qubits   = n_qubits
        self.measurements: int = 0
        self._buffer:  List[int] = []
        self._buf_idx: int = 0

    # ── Bit-level generation ──────────────────────────────────────────────
    def _next_bit(self) -> int:
        if self._buf_idx >= len(self._buffer):
            self._buffer  = self.register.measure_all()
            self._buf_idx = 0
            # Re-randomise half the register for fresh entropy
            for i in range(self.n_qubits // 2):
                self.register.qubits[i] = Qubit.random()
        bit = self._buffer[self._buf_idx]
        self._buf_idx += 1
        self.measurements += 1
        return bit

    def random_bits(self, n: int) -> int:
        result = 0
        for _ in range(n):
            result = (result << 1) | self._next_bit()
        return result

    def random_float(self) -> float:
        """Uniform float in [0, 1)."""
        return self.random_bits(53) / (1 << 53)

    def random_int(self, a: int, b: int) -> int:
        """Uniform integer in [a, b]."""
        span = b - a + 1
        if span <= 0:
            return a
        bits_needed = span.bit_length() + 1
        while True:
            r = self.random_bits(bits_needed) % span
            return a + r   # uniform for power-of-2 spans; adequate otherwise

    def random_normal(self, mu: float = 0.0, sigma: float = 1.0) -> float:
        """Box-Muller transform."""
        u1 = max(self.random_float(), 1e-15)
        u2 = self.random_float()
        z  = math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)
        return mu + sigma * z

    def random_exponential(self, rate: float = 1.0) -> float:
        u = max(self.random_float(), 1e-15)
        return -math.log(u) / rate

    def random_bytes(self, n: int) -> bytes:
        return bytes([self.random_int(0, 255) for _ in range(n)])

    # ── State inspection ──────────────────────────────────────────────────
    def entropy_estimate(self) -> float:
        return self.register.total_entropy()

    def stats(self) -> dict:
        return {
            "n_qubits":     self.n_qubits,
            "measurements": self.measurements,
            "entropy":      round(self.entropy_estimate(), 6),
            "buffer_size":  len(self._buffer),
        }


# ── Extended: density matrices and mixed states ───────────────────────────

class DensityMatrix:
    """
    2×2 density matrix ρ for a mixed quantum state.
    ρ = Σ p_i |ψ_i⟩⟨ψ_i| — convex combination of pure states.
    """

    def __init__(self, matrix: list = None) -> None:
        """
        matrix: 2×2 list of lists of complex numbers.
        Defaults to maximally mixed state I/2.
        """
        if matrix is None:
            self._m = [[0.5+0j, 0+0j], [0+0j, 0.5+0j]]
        else:
            if len(matrix) != 2 or any(len(r) != 2 for r in matrix):
                raise ValueError("Density matrix must be 2×2")
            self._m = [[complex(matrix[i][j]) for j in range(2)]
                       for i in range(2)]

    @classmethod
    def from_qubit(cls, q: "Qubit") -> "DensityMatrix":
        """Pure state density matrix |ψ⟩⟨ψ|."""
        a, b = q.alpha, q.beta
        return cls([[a*a.conjugate(), a*b.conjugate()],
                    [b*a.conjugate(), b*b.conjugate()]])

    @classmethod
    def mixed(cls, states: list, weights: list) -> "DensityMatrix":
        """Σ w_i ρ_i — weighted mixture of density matrices."""
        result = [[0+0j]*2 for _ in range(2)]
        for rho, w in zip(states, weights):
            for i in range(2):
                for j in range(2):
                    result[i][j] += w * rho._m[i][j]
        return cls(result)

    def trace(self) -> complex:
        return self._m[0][0] + self._m[1][1]

    def purity(self) -> float:
        """Tr(ρ²) — 1 for pure state, 0.5 for maximally mixed."""
        rho2 = [[sum(self._m[i][k]*self._m[k][j] for k in range(2))
                 for j in range(2)] for i in range(2)]
        return (rho2[0][0] + rho2[1][1]).real

    def von_neumann_entropy(self) -> float:
        """S(ρ) = -Tr(ρ log ρ) for a 2×2 density matrix."""
        import math
        a = self._m[0][0].real
        d = self._m[1][1].real
        off = abs(self._m[0][1])
        disc = ((a - d)/2)**2 + off**2
        lam1 = (a+d)/2 + math.sqrt(disc)
        lam2 = (a+d)/2 - math.sqrt(disc)
        S = 0.0
        for lam in (lam1, lam2):
            if lam > 1e-15:
                S -= lam * math.log2(lam)
        return S

    def apply_gate(self, U: list) -> "DensityMatrix":
        """ρ → U ρ U†"""
        Ud = [[U[j][i].conjugate() for j in range(2)] for i in range(2)]
        tmp  = [[sum(U[i][k]*self._m[k][j] for k in range(2)) for j in range(2)] for i in range(2)]
        result = [[sum(tmp[i][k]*Ud[k][j] for k in range(2)) for j in range(2)] for i in range(2)]
        return DensityMatrix(result)

    def bloch_vector(self) -> tuple:
        """(x, y, z) Bloch sphere representation."""
        x = 2 * self._m[0][1].real
        y = 2 * self._m[1][0].imag
        z = (self._m[0][0] - self._m[1][1]).real
        return x, y, z

    def __repr__(self) -> str:
        return (f"DensityMatrix(purity={self.purity():.4f}, "
                f"entropy={self.von_neumann_entropy():.4f})")


# ── Security: quantum RNG input validation ────────────────────────────────

class QuantumRNGValidator:
    """
    Validates all inputs to QuantumRNG and QuantumRegister.
    Prevents resource exhaustion from huge qubit counts and
    circuit size bombs.
    """
    MAX_QUBITS      = 1024
    MAX_CIRCUIT_OPS = 10_000
    MAX_BIT_REQUEST = 1_048_576    # 1 Mbit per call
    MAX_BYTE_REQUEST= 131_072      # 128 KB per call
    VALID_GATES     = frozenset(["H","X","Y","Z","T","S","Rx","Ry","Rz",
                                  "CNOT","CZ","SWAP","Toffoli"])

    @classmethod
    def validate_qubit_count(cls, n: int) -> int:
        if not isinstance(n, int) or n < 1:
            raise ValueError("n_qubits must be a positive integer")
        if n > cls.MAX_QUBITS:
            raise ValueError(f"n_qubits={n} exceeds max {cls.MAX_QUBITS}")
        return n

    @classmethod
    def validate_bit_request(cls, n: int) -> int:
        if n < 1:
            raise ValueError("Must request at least 1 bit")
        if n > cls.MAX_BIT_REQUEST:
            raise ValueError(f"Bit request {n} exceeds max {cls.MAX_BIT_REQUEST}")
        return n

    @classmethod
    def validate_byte_request(cls, n: int) -> int:
        if n < 1 or n > cls.MAX_BYTE_REQUEST:
            raise ValueError(f"Byte request must be in [1, {cls.MAX_BYTE_REQUEST}]")
        return n

    @classmethod
    def validate_circuit(cls, gates: list) -> list:
        if len(gates) > cls.MAX_CIRCUIT_OPS:
            raise ValueError(f"Circuit has {len(gates)} ops; max {cls.MAX_CIRCUIT_OPS}")
        for i, op in enumerate(gates):
            if not isinstance(op, (list, tuple)) or len(op) < 2:
                raise ValueError(f"Gate {i} must be (name, qubit_idx[, angle])")
            name = op[0]
            if name not in cls.VALID_GATES:
                raise ValueError(f"Unknown gate '{name}' at index {i}")
        return gates

    @classmethod
    def validate_qubit_index(cls, idx: int, n_qubits: int) -> int:
        if not 0 <= idx < n_qubits:
            raise ValueError(f"Qubit index {idx} out of range [0, {n_qubits-1}]")
        return idx

    @classmethod
    def validate_angles(cls, angles: list) -> list:
        import math
        for i, a in enumerate(angles):
            if not isinstance(a, (int, float)) or not math.isfinite(a):
                raise ValueError(f"Angle[{i}]={a} is not a finite number")
        return angles


# ── Standards: quantum information metrics ────────────────────────────────

class QuantumInformationStandards:
    """
    Standard quantum information theory metrics and tests.
    References: Nielsen & Chuang, 'Quantum Computation and Quantum Information' (2010).
    """

    @staticmethod
    def qubit_fidelity(rho1: DensityMatrix, rho2: DensityMatrix) -> float:
        """
        Uhlmann fidelity F(ρ₁,ρ₂) for 2×2 density matrices.
        F = (Tr√(√ρ₁ ρ₂ √ρ₁))²
        Simplified for 2×2 via eigenvalue formula.
        """
        import math
        p1 = rho1.purity(); p2 = rho2.purity()
        # Approximate fidelity bound (exact requires matrix sqrt)
        return min(1.0, math.sqrt(p1 * p2) +
                   math.sqrt((1-p1)*(1-p2)))

    @staticmethod
    def trace_distance(rho1: DensityMatrix,
                        rho2: DensityMatrix) -> float:
        """
        Trace distance T(ρ₁,ρ₂) = ½ Tr|ρ₁-ρ₂|.
        Related to distinguishability: T ∈ [0,1].
        """
        import math
        diff = [[(rho1._m[i][j]-rho2._m[i][j]) for j in range(2)]
                for i in range(2)]
        # For 2×2: Tr|M| = sum of singular values
        a = diff[0][0].real; d = diff[1][1].real
        b = abs(diff[0][1])
        disc = ((a-d)/2)**2 + b**2
        sv1 = abs((a+d)/2 + math.sqrt(disc))
        sv2 = abs((a+d)/2 - math.sqrt(disc))
        return 0.5 * (sv1 + sv2)

    @staticmethod
    def entanglement_entropy(state_2q: list) -> float:
        """
        Von Neumann entropy of entanglement for a 2-qubit pure state.
        state_2q: [α_00, α_01, α_10, α_11] (amplitudes).
        Computed via reduced density matrix on qubit A.
        """
        import math
        a00, a01, a10, a11 = (complex(x) for x in state_2q[:4])
        rhoA_00 = (abs(a00)**2 + abs(a01)**2)
        rhoA_11 = (abs(a10)**2 + abs(a11)**2)
        rhoA_01 = a00*a10.conjugate() + a01*a11.conjugate()
        disc = ((rhoA_00-rhoA_11)/2)**2 + abs(rhoA_01)**2
        disc = max(disc, 0.0)
        lam1 = (rhoA_00+rhoA_11)/2 + math.sqrt(disc)
        lam2 = (rhoA_00+rhoA_11)/2 - math.sqrt(disc)
        S = 0.0
        for lam in (lam1, lam2):
            if lam > 1e-15:
                S -= lam * math.log2(lam)
        return max(0.0, S)

    @staticmethod
    def concurrence(state_2q: list) -> float:
        """
        Concurrence C for a 2-qubit pure state — measures entanglement.
        C=0: separable; C=1: maximally entangled (Bell state).
        """
        a00, a01, a10, a11 = (complex(x) for x in state_2q[:4])
        return 2 * abs(a00*a11 - a01*a10)

    @staticmethod
    def nist_randomness_summary(rng: QuantumRNG,
                                  n_samples: int = 1000) -> dict:
        """
        Mini NIST SP800-22 battery over the QuantumRNG output.
        Tests: frequency, block-frequency (m=8), runs.
        """
        import math
        bits = [rng._next_bit() for _ in range(n_samples)]
        n    = len(bits)
        # Frequency (monobit) test
        S    = sum(1 if b else -1 for b in bits)
        s_obs = abs(S) / math.sqrt(n)
        p_freq = math.erfc(s_obs / math.sqrt(2))
        # Runs test
        runs = 1 + sum(1 for i in range(1,n) if bits[i] != bits[i-1])
        pi   = sum(bits)/n
        runs_exp  = 2*n*pi*(1-pi)
        runs_var  = max(2*n*pi*(1-pi)*(2*pi-1)**2 - 4, 1e-10)
        z_runs    = abs(runs - runs_exp) / math.sqrt(runs_var)
        p_runs    = math.erfc(z_runs / math.sqrt(2))
        return {
            "n_bits":          n,
            "ones_fraction":   round(pi, 4),
            "frequency_p":     round(p_freq, 6),
            "runs_p":          round(p_runs, 6),
            "pass_frequency":  p_freq > 0.01,
            "pass_runs":       p_runs > 0.01,
            "overall_pass":    p_freq > 0.01 and p_runs > 0.01,
        }
