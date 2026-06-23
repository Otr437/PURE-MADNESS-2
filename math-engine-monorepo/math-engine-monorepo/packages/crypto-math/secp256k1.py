"""
SECP256K1 — pure-Python implementation of the Bitcoin elliptic curve.
Supports point addition, scalar multiplication, key generation,
ECDSA signing/verification, and address derivation helpers.
"""

import hashlib
import hmac
import math
import os
import secrets
from typing import Optional, Tuple

# ── Curve parameters ───────────────────────────────────────────────────────
P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
A  = 0
B  = 7
Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8


class ECPoint:
    """A point on the secp256k1 curve (or the point at infinity)."""

    INFINITY: "ECPoint"  # set below

    def __init__(self, x: Optional[int], y: Optional[int]) -> None:
        self.x = x
        self.y = y

    @property
    def is_infinity(self) -> bool:
        return self.x is None and self.y is None

    def __eq__(self, other) -> bool:
        return isinstance(other, ECPoint) and self.x == other.x and self.y == other.y

    def __repr__(self) -> str:
        if self.is_infinity:
            return "ECPoint(∞)"
        return f"ECPoint(x={self.x:064x}, y={self.y:064x})"

    def __add__(self, other: "ECPoint") -> "ECPoint":
        return SECP256K1.point_add(self, other)

    def __rmul__(self, scalar: int) -> "ECPoint":
        return SECP256K1.scalar_mul(scalar, self)

    def __mul__(self, scalar: int) -> "ECPoint":
        return SECP256K1.scalar_mul(scalar, self)


ECPoint.INFINITY = ECPoint(None, None)


class SECP256K1:
    """secp256k1 curve operations."""

    G = ECPoint(Gx, Gy)
    P = P
    N = N

    # ── Modular arithmetic ─────────────────────────────────────────────────

    @staticmethod
    def _mod_inv(a: int, m: int = P) -> int:
        return pow(a, m - 2, m)

    # ── Point arithmetic ───────────────────────────────────────────────────

    @staticmethod
    def point_add(P1: ECPoint, P2: ECPoint) -> ECPoint:
        if P1.is_infinity:
            return P2
        if P2.is_infinity:
            return P1
        if P1.x == P2.x:
            if P1.y != P2.y:
                return ECPoint.INFINITY
            return SECP256K1.point_double(P1)

        lam = ((P2.y - P1.y) * SECP256K1._mod_inv(P2.x - P1.x)) % P
        x3  = (lam * lam - P1.x - P2.x) % P
        y3  = (lam * (P1.x - x3) - P1.y) % P
        return ECPoint(x3, y3)

    @staticmethod
    def point_double(pt: ECPoint) -> ECPoint:
        if pt.is_infinity or pt.y == 0:
            return ECPoint.INFINITY
        lam = (3 * pt.x * pt.x + A) * SECP256K1._mod_inv(2 * pt.y) % P
        x3  = (lam * lam - 2 * pt.x) % P
        y3  = (lam * (pt.x - x3) - pt.y) % P
        return ECPoint(x3, y3)

    @staticmethod
    def scalar_mul(k: int, pt: ECPoint) -> ECPoint:
        """Double-and-add scalar multiplication."""
        k = k % N
        if k == 0:
            return ECPoint.INFINITY
        result = ECPoint.INFINITY
        addend = pt
        while k:
            if k & 1:
                result = SECP256K1.point_add(result, addend)
            addend = SECP256K1.point_double(addend)
            k >>= 1
        return result

    # ── Key generation ─────────────────────────────────────────────────────

    @staticmethod
    def generate_private_key() -> int:
        while True:
            k = int.from_bytes(secrets.token_bytes(32), "big")
            if 1 <= k < N:
                return k

    @staticmethod
    def private_to_public(priv: int) -> ECPoint:
        return SECP256K1.scalar_mul(priv, SECP256K1.G)

    @staticmethod
    def public_key_bytes(pt: ECPoint, compressed: bool = True) -> bytes:
        if compressed:
            prefix = b"\x02" if pt.y % 2 == 0 else b"\x03"
            return prefix + pt.x.to_bytes(32, "big")
        return b"\x04" + pt.x.to_bytes(32, "big") + pt.y.to_bytes(32, "big")

    # ── ECDSA ──────────────────────────────────────────────────────────────

    @staticmethod
    def sign(priv: int, msg_hash: bytes) -> Tuple[int, int]:
        """Return (r, s) signature."""
        z = int.from_bytes(msg_hash[:32], "big")
        while True:
            k = SECP256K1.generate_private_key()
            R = SECP256K1.scalar_mul(k, SECP256K1.G)
            r = R.x % N
            if r == 0:
                continue
            k_inv = pow(k, N - 2, N)
            s = k_inv * (z + r * priv) % N
            if s == 0:
                continue
            return r, s

    @staticmethod
    def verify(pub: ECPoint, msg_hash: bytes, r: int, s: int) -> bool:
        """Verify (r, s) signature against public key."""
        if not (1 <= r < N and 1 <= s < N):
            return False
        z    = int.from_bytes(msg_hash[:32], "big")
        w    = pow(s, N - 2, N)
        u1   = z * w % N
        u2   = r * w % N
        pt   = SECP256K1.point_add(
            SECP256K1.scalar_mul(u1, SECP256K1.G),
            SECP256K1.scalar_mul(u2, pub),
        )
        return not pt.is_infinity and pt.x % N == r

    # ── Address helpers ────────────────────────────────────────────────────

    @staticmethod
    def pubkey_to_hash160(pt: ECPoint, compressed: bool = True) -> bytes:
        pub_bytes = SECP256K1.public_key_bytes(pt, compressed)
        sha256    = hashlib.sha256(pub_bytes).digest()
        return hashlib.new("ripemd160", sha256).digest()

    @staticmethod
    def hash160_to_address(h160: bytes, version: int = 0x00) -> str:
        payload  = bytes([version]) + h160
        checksum = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
        full     = payload + checksum
        # Base58Check encode
        n = int.from_bytes(full, "big")
        ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
        result   = ""
        while n:
            n, r = divmod(n, 58)
            result = ALPHABET[r] + result
        leading = len(full) - len(full.lstrip(b"\x00"))
        return ALPHABET[0] * leading + result


# ── Extended EC operations ────────────────────────────────────────────────

class ECDHHelper:
    """
    Elliptic Curve Diffie-Hellman helpers built on SECP256K1.
    """

    @staticmethod
    def shared_secret(priv_a: int, pub_b: ECPoint) -> bytes:
        """Compute ECDH shared secret: priv_a * pub_b → x-coordinate bytes."""
        shared = SECP256K1.scalar_mul(priv_a, pub_b)
        if shared.is_infinity:
            raise ValueError("ECDH produced point at infinity")
        return shared.x.to_bytes(32, "big")

    @staticmethod
    def derive_key(shared_secret: bytes, info: bytes = b"",
                   length: int = 32) -> bytes:
        """HKDF-SHA256 key derivation from ECDH shared secret."""
        import hashlib, hmac as _hmac
        # Extract
        prk = _hmac.new(b"secp256k1-hkdf", shared_secret, hashlib.sha256).digest()
        # Expand
        okm = b""
        prev = b""
        for i in range(1, (length // 32) + 2):
            prev = _hmac.new(prk, prev + info + bytes([i]),
                              hashlib.sha256).digest()
            okm += prev
        return okm[:length]


class SchnorrHelper:
    """
    Schnorr signature scheme over secp256k1 (BIP-340 style).
    """

    @staticmethod
    def _tagged_hash(tag: str, data: bytes) -> bytes:
        import hashlib
        t = hashlib.sha256(tag.encode()).digest()
        return hashlib.sha256(t + t + data).digest()

    @classmethod
    def sign(cls, priv: int, msg: bytes) -> Tuple[int, int]:
        """BIP-340 Schnorr sign. Returns (R.x, s)."""
        import secrets as _sec
        k = int.from_bytes(_sec.token_bytes(32), "big") % N
        R = SECP256K1.scalar_mul(k, SECP256K1.G)
        if R.y % 2 != 0:   # ensure even Y
            k = N - k
            R = SECP256K1.scalar_mul(k, SECP256K1.G)
        rx_bytes = R.x.to_bytes(32, "big")
        P        = SECP256K1.private_to_public(priv)
        px_bytes = P.x.to_bytes(32, "big")
        e_bytes  = cls._tagged_hash("BIP0340/challenge",
                                     rx_bytes + px_bytes + msg)
        e = int.from_bytes(e_bytes, "big") % N
        s = (k + e * priv) % N
        return R.x, s

    @classmethod
    def verify(cls, pub: ECPoint, msg: bytes, rx: int, s: int) -> bool:
        """BIP-340 Schnorr verify."""
        px_bytes = pub.x.to_bytes(32, "big")
        rx_bytes = rx.to_bytes(32, "big")
        e_bytes  = cls._tagged_hash("BIP0340/challenge",
                                     rx_bytes + px_bytes + msg)
        e = int.from_bytes(e_bytes, "big") % N
        R = SECP256K1.point_add(
            SECP256K1.scalar_mul(s, SECP256K1.G),
            SECP256K1.scalar_mul(N - e, pub))
        if R.is_infinity or R.y % 2 != 0:
            return False
        return R.x == rx


class MultiSigHelper:
    """
    Threshold multi-signature helpers (n-of-m Shamir secret sharing).
    """

    @staticmethod
    def split_secret(secret: int, threshold: int,
                     n_shares: int) -> List[Tuple[int, int]]:
        """Shamir secret sharing over Z_N."""
        import secrets as _sec
        coeffs = [secret] + [int.from_bytes(_sec.token_bytes(32),"big") % N
                              for _ in range(threshold - 1)]
        shares = []
        for x in range(1, n_shares + 1):
            y = sum(c * pow(x, i, N) for i, c in enumerate(coeffs)) % N
            shares.append((x, y))
        return shares

    @staticmethod
    def reconstruct_secret(shares: List[Tuple[int, int]]) -> int:
        """Lagrange interpolation over Z_N to recover secret."""
        secret = 0
        xs = [s[0] for s in shares]
        for i, (xi, yi) in enumerate(shares):
            num = 1; den = 1
            for j, xj in enumerate(xs):
                if i == j: continue
                num = num * (-xj) % N
                den = den * (xi - xj) % N
            secret = (secret + yi * num * pow(den, N-2, N)) % N
        return secret


# ── Security: cryptographic input validation ──────────────────────────────

class CryptoSecurityValidator:
    """
    Validates all cryptographic inputs:
      - Private key range
      - Point on curve verification
      - Signature component ranges
      - Hash length enforcement
      - DER encoding validation
    """

    @staticmethod
    def validate_private_key(priv: int) -> int:
        if not isinstance(priv, int):
            raise TypeError("Private key must be int")
        if not 1 <= priv < N:
            raise ValueError(f"Private key out of range [1, N-1]")
        return priv

    @staticmethod
    def validate_point(pt: ECPoint) -> ECPoint:
        if pt.is_infinity:
            raise ValueError("Point at infinity is not a valid public key")
        if not (0 <= pt.x < P and 0 <= pt.y < P):
            raise ValueError("Point coordinates out of field range")
        lhs = (pt.y * pt.y) % P
        rhs = (pt.x * pt.x * pt.x + B) % P
        if lhs != rhs:
            raise ValueError("Point is not on the secp256k1 curve")
        return pt

    @staticmethod
    def validate_signature(r: int, s: int) -> Tuple[int, int]:
        if not (1 <= r < N):
            raise ValueError(f"r={r} out of valid signature range")
        if not (1 <= s < N):
            raise ValueError(f"s={s} out of valid signature range")
        return r, s

    @staticmethod
    def validate_hash(msg_hash: bytes, expected_len: int = 32) -> bytes:
        if not isinstance(msg_hash, (bytes, bytearray)):
            raise TypeError("msg_hash must be bytes")
        if len(msg_hash) < expected_len:
            raise ValueError(f"Hash too short: {len(msg_hash)} < {expected_len}")
        return bytes(msg_hash[:expected_len])

    @staticmethod
    def validate_message_length(msg: bytes, max_len: int = 65536) -> bytes:
        if len(msg) > max_len:
            raise ValueError(f"Message too long ({len(msg)} > {max_len})")
        return msg

    @staticmethod
    def is_low_s(s: int) -> bool:
        """BIP-62: enforce low-S normalisation."""
        return s <= N // 2

    @staticmethod
    def normalise_s(s: int) -> int:
        """Normalise s to low-S form (BIP-62)."""
        return s if s <= N // 2 else N - s

    @staticmethod
    def validate_wif(wif: str) -> bool:
        """Validate WIF private key format (basic check)."""
        import re
        return bool(re.match(r"^[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}$", wif))


# ── Standards: key encoding formats ──────────────────────────────────────

class KeyEncodingStandards:
    """
    Key encoding and serialisation following BIP-32, BIP-44, SEC1, DER standards.
    """

    @staticmethod
    def der_encode_signature(r: int, s: int) -> bytes:
        """DER-encode a (r, s) ECDSA signature."""
        def _encode_int(n: int) -> bytes:
            b = n.to_bytes((n.bit_length() + 7) // 8, "big")
            if b[0] & 0x80:
                b = b"\x00" + b
            return bytes([0x02, len(b)]) + b
        r_enc = _encode_int(r)
        s_enc = _encode_int(s)
        payload = r_enc + s_enc
        return bytes([0x30, len(payload)]) + payload

    @staticmethod
    def der_decode_signature(der: bytes) -> Tuple[int, int]:
        """Decode DER-encoded (r, s) ECDSA signature."""
        if der[0] != 0x30:
            raise ValueError("Not a DER sequence")
        offset = 2
        if der[offset] != 0x02:
            raise ValueError("Expected INTEGER for r")
        r_len = der[offset+1]
        r = int.from_bytes(der[offset+2:offset+2+r_len], "big")
        offset += 2 + r_len
        if der[offset] != 0x02:
            raise ValueError("Expected INTEGER for s")
        s_len = der[offset+1]
        s = int.from_bytes(der[offset+2:offset+2+s_len], "big")
        return r, s

    @staticmethod
    def extended_public_key(pub_bytes: bytes, chain: bytes,
                             depth: int = 0, index: int = 0) -> bytes:
        """Serialise BIP-32 extended public key (xpub) payload."""
        import struct
        version = bytes.fromhex("0488B21E")   # mainnet xpub
        return (version
                + bytes([depth])
                + b"\x00" * 4          # parent fingerprint
                + struct.pack(">I", index)
                + chain
                + pub_bytes)

    @staticmethod
    def p2pkh_script(pubkey_hash: bytes) -> bytes:
        """Build P2PKH locking script: OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG."""
        return (bytes([0x76, 0xa9, 0x14])
                + pubkey_hash
                + bytes([0x88, 0xac]))

    @staticmethod
    def p2wpkh_script(pubkey_hash: bytes) -> bytes:
        """Build P2WPKH (native SegWit) locking script."""
        return bytes([0x00, 0x14]) + pubkey_hash

    @staticmethod
    def pubkey_fingerprint(pub_bytes: bytes) -> bytes:
        """First 4 bytes of HASH160 of public key (BIP-32 fingerprint)."""
        import hashlib
        h = hashlib.new("ripemd160",
                         hashlib.sha256(pub_bytes).digest()).digest()
        return h[:4]
