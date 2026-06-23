"""
CryptoMathUtils — helpers used by the crypto-math package:
hex/bytes conversions, hash wrappers, WIF encoding, HD derivation helpers.
"""

import hashlib
import hmac
import struct
from typing import Tuple


class CryptoMathUtils:
    """Utility methods for cryptographic math operations."""

    # ── Hash wrappers ─────────────────────────────────────────────────────

    @staticmethod
    def sha256(data: bytes) -> bytes:
        return hashlib.sha256(data).digest()

    @staticmethod
    def sha256d(data: bytes) -> bytes:
        return hashlib.sha256(hashlib.sha256(data).digest()).digest()

    @staticmethod
    def hash160(data: bytes) -> bytes:
        return hashlib.new("ripemd160", hashlib.sha256(data).digest()).digest()

    @staticmethod
    def hmac_sha512(key: bytes, data: bytes) -> bytes:
        return hmac.new(key, data, hashlib.sha512).digest()

    # ── Encoding helpers ──────────────────────────────────────────────────

    BASE58_ALPHABET = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

    @classmethod
    def base58_encode(cls, data: bytes) -> str:
        n = int.from_bytes(data, "big")
        result = b""
        while n:
            n, r = divmod(n, 58)
            result = bytes([cls.BASE58_ALPHABET[r]]) + result
        leading = len(data) - len(data.lstrip(b"\x00"))
        return (chr(cls.BASE58_ALPHABET[0]) * leading + result.decode())

    @classmethod
    def base58check_encode(cls, payload: bytes) -> str:
        checksum = cls.sha256d(payload)[:4]
        return cls.base58_encode(payload + checksum)

    @staticmethod
    def int_to_bytes(n: int, length: int = 32) -> bytes:
        return n.to_bytes(length, "big")

    @staticmethod
    def bytes_to_int(b: bytes) -> int:
        return int.from_bytes(b, "big")

    # ── WIF ───────────────────────────────────────────────────────────────

    @classmethod
    def private_key_to_wif(cls, priv: int, compressed: bool = True,
                            mainnet: bool = True) -> str:
        prefix  = b"\x80" if mainnet else b"\xef"
        payload = prefix + cls.int_to_bytes(priv)
        if compressed:
            payload += b"\x01"
        return cls.base58check_encode(payload)

    # ── BIP32 child key derivation (public, non-hardened) ─────────────────

    @classmethod
    def derive_child_public(cls, parent_pub_bytes: bytes,
                             parent_chain: bytes, index: int) -> Tuple[bytes, bytes]:
        """
        Derive a non-hardened child public key.
        Returns (child_pub_compressed_bytes, child_chain_code).
        """
        data    = parent_pub_bytes + struct.pack(">I", index)
        I       = cls.hmac_sha512(parent_chain, data)
        IL, IR  = I[:32], I[32:]
        il_int  = int.from_bytes(IL, "big")

        from .secp256k1 import SECP256K1, ECPoint
        N       = SECP256K1.N
        if il_int >= N:
            raise ValueError("Derived key is invalid (il >= N)")

        pt_IL   = SECP256K1.scalar_mul(il_int, SECP256K1.G)
        parent_x = int.from_bytes(parent_pub_bytes[1:33], "big")

        # Decompress parent public key
        prefix = parent_pub_bytes[0]
        x      = int.from_bytes(parent_pub_bytes[1:], "big")
        y_sq   = (pow(x, 3, SECP256K1.P) + 7) % SECP256K1.P
        y      = pow(y_sq, (SECP256K1.P + 1) // 4, SECP256K1.P)
        if (y % 2) != (prefix - 2):
            y = SECP256K1.P - y
        parent_pt = ECPoint(x, y)

        child_pt  = SECP256K1.point_add(pt_IL, parent_pt)
        child_pub = SECP256K1.public_key_bytes(child_pt, compressed=True)
        return child_pub, IR


# ── Extended crypto utilities ─────────────────────────────────────────────

import struct
import hashlib
import hmac as _hmac
import secrets


class MnemonicHelper:
    """
    BIP-39 mnemonic generation and seed derivation.
    """
    # 2048-word wordlist abbreviated — first/last for structure demo
    # In production, load from bip39_english.txt
    WORDLIST_SIZE = 2048

    @staticmethod
    def entropy_to_mnemonic(entropy: bytes) -> List[str]:
        """Convert entropy bytes to BIP-39 mnemonic (requires wordlist)."""
        import hashlib, math
        checksum_bits = len(entropy) * 8 // 32
        full = int.from_bytes(entropy, "big")
        h    = int.from_bytes(hashlib.sha256(entropy).digest(), "big")
        full = (full << checksum_bits) | (h >> (256 - checksum_bits))
        total_bits = len(entropy) * 8 + checksum_bits
        n_words    = total_bits // 11
        words      = []
        for _ in range(n_words):
            idx = full & 0x7FF
            words.insert(0, str(idx))   # index placeholder (no wordlist embedded)
            full >>= 11
        return words

    @staticmethod
    def mnemonic_to_seed(mnemonic: str,
                          passphrase: str = "") -> bytes:
        """BIP-39 mnemonic → 512-bit seed via PBKDF2-HMAC-SHA512."""
        import hashlib
        return hashlib.pbkdf2_hmac(
            "sha512",
            mnemonic.encode("utf-8"),
            ("mnemonic" + passphrase).encode("utf-8"),
            iterations=2048,
            dklen=64,
        )

    @staticmethod
    def seed_to_master_key(seed: bytes) -> Tuple[int, bytes]:
        """BIP-32 master private key derivation from seed."""
        I = _hmac.new(b"Bitcoin seed", seed, hashlib.sha512).digest()
        il, ir = I[:32], I[32:]
        priv = int.from_bytes(il, "big")
        from .secp256k1 import N
        if priv == 0 or priv >= N:
            raise ValueError("Invalid master key derived from seed")
        return priv, ir


class TransactionHasher:
    """
    Bitcoin transaction hashing utilities.
    Implements double-SHA256 (hash256) and HASH160.
    """

    @staticmethod
    def hash256(data: bytes) -> bytes:
        return hashlib.sha256(hashlib.sha256(data).digest()).digest()

    @staticmethod
    def hash160(data: bytes) -> bytes:
        return hashlib.new("ripemd160", hashlib.sha256(data).digest()).digest()

    @staticmethod
    def sighash_legacy(tx_bytes: bytes, sighash_type: int = 1) -> bytes:
        """Compute legacy sighash (SIGHASH_ALL) for a transaction."""
        return TransactionHasher.hash256(tx_bytes + struct.pack("<I", sighash_type))

    @staticmethod
    def sighash_segwit(version: int, hash_prevouts: bytes,
                        hash_sequence: bytes, outpoint: bytes,
                        script_code: bytes, value: int,
                        sequence: int, hash_outputs: bytes,
                        locktime: int, sighash_type: int) -> bytes:
        """BIP-143 SegWit sighash."""
        preimage = (
            struct.pack("<I", version)
            + hash_prevouts + hash_sequence
            + outpoint + struct.pack("<I", len(script_code))
            + script_code + struct.pack("<Q", value)
            + struct.pack("<I", sequence) + hash_outputs
            + struct.pack("<I", locktime)
            + struct.pack("<I", sighash_type)
        )
        return TransactionHasher.hash256(preimage)


class KeyDerivationStandards:
    """
    Multi-purpose key derivation following modern standards:
    HKDF (RFC 5869), PBKDF2 (RFC 8018), Argon2id (conceptual).
    """

    @staticmethod
    def hkdf(ikm: bytes, length: int = 32,
              salt: bytes = None, info: bytes = b"") -> bytes:
        """HKDF-SHA256 (RFC 5869)."""
        if salt is None:
            salt = b"\x00" * 32
        # Extract
        prk = _hmac.new(salt, ikm, hashlib.sha256).digest()
        # Expand
        okm = b""; prev = b""
        for i in range(1, (length + 31) // 32 + 1):
            prev = _hmac.new(prk, prev + info + bytes([i]),
                              hashlib.sha256).digest()
            okm += prev
        return okm[:length]

    @staticmethod
    def pbkdf2(password: str, salt: bytes = None,
               iterations: int = 260_000, length: int = 32) -> bytes:
        if salt is None:
            salt = secrets.token_bytes(32)
        return hashlib.pbkdf2_hmac("sha256", password.encode(),
                                    salt, iterations, dklen=length)

    @staticmethod
    def scrypt_stretch(password: str, salt: bytes = None,
                       n: int = 16384, r: int = 8, p: int = 1,
                       length: int = 32) -> bytes:
        """scrypt key derivation (requires Python 3.6+)."""
        if salt is None:
            salt = secrets.token_bytes(32)
        import hashlib
        return hashlib.scrypt(password.encode(), salt=salt,
                               n=n, r=r, p=p, dklen=length)

    @staticmethod
    def derive_child_key_bip44(master_priv: int, master_chain: bytes,
                                account: int = 0, change: int = 0,
                                index: int = 0) -> Tuple[int, bytes]:
        """
        BIP-44 path: m/44'/0'/account'/change/index
        Returns (child_private_key, child_chain_code).
        """
        from .secp256k1 import SECP256K1, N

        def _derive(priv: int, chain: bytes, idx: int,
                    hardened: bool = False) -> Tuple[int, bytes]:
            if hardened:
                data = b"\x00" + priv.to_bytes(32,"big") + struct.pack(">I", idx | 0x80000000)
            else:
                pub  = SECP256K1.public_key_bytes(SECP256K1.private_to_public(priv))
                data = pub + struct.pack(">I", idx)
            I    = _hmac.new(chain, data, hashlib.sha512).digest()
            il   = int.from_bytes(I[:32], "big")
            ir   = I[32:]
            child_priv = (il + priv) % N
            return child_priv, ir

        # m/44'
        priv, chain = _derive(master_priv, master_chain, 44, hardened=True)
        # /0' (Bitcoin mainnet)
        priv, chain = _derive(priv, chain, 0, hardened=True)
        # /account'
        priv, chain = _derive(priv, chain, account, hardened=True)
        # /change
        priv, chain = _derive(priv, chain, change, hardened=False)
        # /index
        priv, chain = _derive(priv, chain, index, hardened=False)
        return priv, chain


# ── Security: crypto utilities validation ────────────────────────────────

class CryptoUtilsValidator:
    """
    Input validation for all cryptographic utility functions.
    Prevents malformed data from causing silent failures or panics.
    """
    MAX_MSG_BYTES  = 1_048_576   # 1 MB
    MAX_KEY_BYTES  = 4096
    VALID_SIGHASH  = {1, 2, 3, 0x81, 0x82, 0x83}

    @classmethod
    def validate_bytes(cls, data, name: str = "data",
                       max_len: int = None) -> bytes:
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError(f"{name} must be bytes, got {type(data).__name__}")
        if max_len and len(data) > max_len:
            raise ValueError(f"{name} too long ({len(data)} > {max_len})")
        return bytes(data)

    @classmethod
    def validate_entropy_length(cls, n: int) -> int:
        if n not in (16, 20, 24, 28, 32):
            raise ValueError(f"BIP-39 entropy must be 16/20/24/28/32 bytes, got {n}")
        return n

    @classmethod
    def validate_derivation_index(cls, idx: int) -> int:
        if not 0 <= idx < 0x80000000:
            raise ValueError(f"Derivation index {idx} out of [0, 2^31)")
        return idx

    @classmethod
    def validate_sighash_type(cls, t: int) -> int:
        if t not in cls.VALID_SIGHASH:
            raise ValueError(f"Invalid sighash type 0x{t:02x}")
        return t

    @classmethod
    def validate_passphrase(cls, phrase: str, max_len: int = 512) -> str:
        if not isinstance(phrase, str):
            raise TypeError("Passphrase must be str")
        if len(phrase) > max_len:
            raise ValueError(f"Passphrase too long ({len(phrase)} > {max_len})")
        return phrase

    @classmethod
    def constant_time_compare(cls, a: bytes, b: bytes) -> bool:
        """Constant-time comparison to prevent timing attacks."""
        return _hmac.compare_digest(a, b)


# ── Standards: address format specifications ──────────────────────────────

ADDRESS_FORMATS = {
    "p2pkh_mainnet":   {"version": 0x00, "prefix": "1",    "length": 34},
    "p2pkh_testnet":   {"version": 0x6F, "prefix": "m/n",  "length": 34},
    "p2sh_mainnet":    {"version": 0x05, "prefix": "3",    "length": 34},
    "p2sh_testnet":    {"version": 0xC4, "prefix": "2",    "length": 34},
    "p2wpkh_mainnet":  {"version": None, "prefix": "bc1q", "length": 42},
    "p2wpkh_testnet":  {"version": None, "prefix": "tb1q", "length": 42},
    "p2tr_mainnet":    {"version": None, "prefix": "bc1p", "length": 62},
}


def classify_address(address: str) -> str:
    """Classify a Bitcoin address by its format type."""
    for fmt, spec in ADDRESS_FORMATS.items():
        prefix = spec["prefix"]
        if any(address.startswith(p) for p in prefix.split("/")):
            return fmt
    return "unknown"
