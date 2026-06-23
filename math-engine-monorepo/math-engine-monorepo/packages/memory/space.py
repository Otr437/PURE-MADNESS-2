"""
MemorySpace, MemoryBlock, Pointer
==================================
Full virtual memory manager with:
  - malloc / free / realloc / calloc
  - Pointer arithmetic and typed reads/writes (i8/i16/i32/i64/f32/f64)
  - Bounds checking with structured MemoryError
  - Stack allocator and Arena allocator
  - Memory tagging (owner, creation time, last-access)
  - GC by age, GC by owner
  - Heap statistics and fragmentation analysis
  - Serialise / deserialise snapshot (for DB persistence)
  - Thread-safe with RLock per operation

Security:
  - All accesses go through bounds checking; raw pointer addresses are
    never exposed as file/network references
  - Allocation sizes capped at MAX_ALLOC_BYTES
  - NULL-address (0x0000) reads/writes raise immediately
"""

import struct
import threading
import time
import zlib
from typing import Any, Dict, List, Optional, Tuple

MAX_ALLOC_BYTES = 256 * 1024 * 1024   # 256 MB per single allocation
NULL_ADDRESS    = 0x0000


class MemoryError(Exception):
    """Raised for bounds violations, null-dereference, or OOM."""


class MemoryBlock:
    """A named, tagged, bounds-checked memory region."""

    __slots__ = ("address","size","data","allocated","owner",
                 "tag","created_at","last_access","protection",
                 "allocation_id")

    _alloc_counter = 0

    def __init__(self, address: int, size: int,
                 owner: str = "user", tag: str = "") -> None:
        MemoryBlock._alloc_counter += 1
        self.address       = address
        self.size          = size
        self.data          = bytearray(size)
        self.allocated     = True
        self.owner         = owner
        self.tag           = tag
        self.created_at    = time.monotonic()
        self.last_access   = time.monotonic()
        self.protection    = "rw"          # r / w / rw / ro
        self.allocation_id = MemoryBlock._alloc_counter

    # ── Raw reads ─────────────────────────────────────────────────────────
    def _check(self, offset: int, size: int, op: str) -> None:
        if not self.allocated:
            raise MemoryError(f"Use-after-free at 0x{self.address:08x}")
        if offset < 0 or offset + size > self.size:
            raise MemoryError(
                f"{op} OOB: addr=0x{self.address+offset:08x} "
                f"size={size} block_size={self.size}")
        if op == "read"  and "r" not in self.protection:
            raise MemoryError(f"Read from write-only block 0x{self.address:08x}")
        if op == "write" and "w" not in self.protection:
            raise MemoryError(f"Write to read-only block 0x{self.address:08x}")

    def read_bytes(self, offset: int, size: int) -> bytes:
        self._check(offset, size, "read")
        self.last_access = time.monotonic()
        return bytes(self.data[offset:offset+size])

    def write_bytes(self, offset: int, data: bytes) -> None:
        self._check(offset, len(data), "write")
        self.last_access = time.monotonic()
        self.data[offset:offset+len(data)] = data

    # ── Typed reads ───────────────────────────────────────────────────────
    def read_i8  (self, off): return struct.unpack_from("b",  self.read_bytes(off,1))[0]
    def read_u8  (self, off): return struct.unpack_from("B",  self.read_bytes(off,1))[0]
    def read_i16 (self, off): return struct.unpack_from("<h", self.read_bytes(off,2))[0]
    def read_u16 (self, off): return struct.unpack_from("<H", self.read_bytes(off,2))[0]
    def read_i32 (self, off): return struct.unpack_from("<i", self.read_bytes(off,4))[0]
    def read_u32 (self, off): return struct.unpack_from("<I", self.read_bytes(off,4))[0]
    def read_i64 (self, off): return struct.unpack_from("<q", self.read_bytes(off,8))[0]
    def read_u64 (self, off): return struct.unpack_from("<Q", self.read_bytes(off,8))[0]
    def read_f32 (self, off): return struct.unpack_from("<f", self.read_bytes(off,4))[0]
    def read_f64 (self, off): return struct.unpack_from("<d", self.read_bytes(off,8))[0]

    # ── Typed writes ──────────────────────────────────────────────────────
    def write_i8  (self, off, v): self.write_bytes(off, struct.pack("b",  v))
    def write_u8  (self, off, v): self.write_bytes(off, struct.pack("B",  v))
    def write_i16 (self, off, v): self.write_bytes(off, struct.pack("<h", v))
    def write_u16 (self, off, v): self.write_bytes(off, struct.pack("<H", v))
    def write_i32 (self, off, v): self.write_bytes(off, struct.pack("<i", v))
    def write_u32 (self, off, v): self.write_bytes(off, struct.pack("<I", v))
    def write_i64 (self, off, v): self.write_bytes(off, struct.pack("<q", v))
    def write_u64 (self, off, v): self.write_bytes(off, struct.pack("<Q", v))
    def write_f32 (self, off, v): self.write_bytes(off, struct.pack("<f", v))
    def write_f64 (self, off, v): self.write_bytes(off, struct.pack("<d", v))

    # ── Convenience: generic read/write (legacy API) ──────────────────────
    def read(self, offset: int, size: int = 1):
        raw = self.read_bytes(offset, size)
        if size == 1: return raw[0]
        return int.from_bytes(raw, "little")

    def write(self, offset: int, value, size: int = 1) -> None:
        if isinstance(value, (bytes, bytearray)):
            self.write_bytes(offset, bytes(value[:size]))
        else:
            self.write_bytes(offset, value.to_bytes(size, "little"))

    # ── Utilities ─────────────────────────────────────────────────────────
    def zero(self) -> None:
        self.data = bytearray(self.size)

    def fill(self, byte: int) -> None:
        self.data = bytearray([byte & 0xFF] * self.size)

    def memcpy(self, src: "MemoryBlock", src_off: int,
                dst_off: int, length: int) -> None:
        raw = src.read_bytes(src_off, length)
        self.write_bytes(dst_off, raw)

    def checksum(self) -> int:
        return zlib.crc32(bytes(self.data)) & 0xFFFFFFFF

    def age(self) -> float:
        """Seconds since last access."""
        return time.monotonic() - self.last_access

    def info(self) -> Dict:
        return {
            "address":       f"0x{self.address:08x}",
            "size":          self.size,
            "allocated":     self.allocated,
            "owner":         self.owner,
            "tag":           self.tag,
            "protection":    self.protection,
            "age_sec":       round(self.age(), 3),
            "alloc_id":      self.allocation_id,
            "checksum":      f"0x{self.checksum():08x}",
        }


class Pointer:
    """Typed pointer into a MemorySpace with arithmetic and safety checks."""

    def __init__(self, space: "MemorySpace", address: int,
                 element_size: int = 1, type_name: str = "u8") -> None:
        self._space        = space
        self._address      = address
        self._element_size = element_size
        self._type_name    = type_name

    @property
    def address(self) -> int:
        return self._address

    @property
    def is_null(self) -> bool:
        return self._address == NULL_ADDRESS

    def _assert_not_null(self) -> None:
        if self.is_null:
            raise MemoryError("NULL pointer dereference")

    # ── Arithmetic ────────────────────────────────────────────────────────
    def __add__(self, offset: int) -> "Pointer":
        return Pointer(self._space, self._address + offset * self._element_size,
                       self._element_size, self._type_name)

    def __sub__(self, offset: int) -> "Pointer":
        return Pointer(self._space, self._address - offset * self._element_size,
                       self._element_size, self._type_name)

    def __iadd__(self, offset: int) -> "Pointer":
        self._address += offset * self._element_size
        return self

    def __isub__(self, offset: int) -> "Pointer":
        self._address -= offset * self._element_size
        return self

    def diff(self, other: "Pointer") -> int:
        """Pointer difference in elements."""
        return (self._address - other._address) // self._element_size

    # ── Dereference ───────────────────────────────────────────────────────
    def deref(self):
        self._assert_not_null()
        return self._space.read(self._address, self._element_size)

    def assign(self, value) -> None:
        self._assert_not_null()
        self._space.write(self._address, value, self._element_size)

    def get(self, index: int):
        self._assert_not_null()
        return self._space.read(self._address + index * self._element_size,
                                self._element_size)

    def set(self, index: int, value) -> None:
        self._assert_not_null()
        self._space.write(self._address + index * self._element_size,
                          value, self._element_size)

    # ── Typed shorthand ───────────────────────────────────────────────────
    def as_i32(self) -> int:
        self._assert_not_null()
        blk = self._space._find_block(self._address)
        return blk.read_i32(self._address - blk.address)

    def as_f64(self) -> float:
        self._assert_not_null()
        blk = self._space._find_block(self._address)
        return blk.read_f64(self._address - blk.address)

    # ── Array helpers ─────────────────────────────────────────────────────
    def read_array(self, count: int) -> List:
        return [self.get(i) for i in range(count)]

    def write_array(self, values: List) -> None:
        for i, v in enumerate(values):
            self.set(i, v)

    def __repr__(self) -> str:
        status = "NULL" if self.is_null else f"0x{self._address:08x}"
        return f"Pointer<{self._type_name}>({status}, stride={self._element_size})"


class StackAllocator:
    """Linear/stack allocator — O(1) alloc, bulk-free only (arena style)."""

    def __init__(self, base: int, capacity: int) -> None:
        self._base     = base
        self._capacity = capacity
        self._top      = base
        self._marks:   List[int] = []

    def alloc(self, size: int, align: int = 8) -> int:
        # Alignment
        mask = align - 1
        addr = (self._top + mask) & ~mask
        if addr + size > self._base + self._capacity:
            raise MemoryError("Stack allocator out of space")
        self._top = addr + size
        return addr

    def push_mark(self) -> None:
        self._marks.append(self._top)

    def pop_mark(self) -> None:
        if self._marks:
            self._top = self._marks.pop()

    def reset(self) -> None:
        self._top = self._base
        self._marks.clear()

    @property
    def used(self) -> int:
        return self._top - self._base

    @property
    def free(self) -> int:
        return self._capacity - self.used


class MemorySpace:
    """Full virtual memory space: malloc/free/realloc + GC + snapshots."""

    def __init__(self, total_size: int = 100 * 1024 * 1024) -> None:
        self.total_size    = total_size
        self._blocks:      Dict[int, MemoryBlock] = {}
        self._next_addr    = 0x1000          # start above NULL page
        self._lock         = threading.RLock()
        self._stack        = StackAllocator(self._next_addr,
                                             min(total_size // 4, 8 * 1024 * 1024))
        self._alloc_count  = 0
        self._free_count   = 0
        self._peak_bytes   = 0

    # ══════════════════════════════════════════════════════════════════════
    # Core allocation
    # ══════════════════════════════════════════════════════════════════════

    def malloc(self, size: int, owner: str = "user",
               tag: str = "", align: int = 8) -> Pointer:
        """Allocate size bytes; returns a Pointer to the block."""
        if size <= 0:
            raise MemoryError(f"Cannot allocate {size} bytes")
        if size > MAX_ALLOC_BYTES:
            raise MemoryError(f"Allocation {size} exceeds MAX_ALLOC_BYTES")
        with self._lock:
            # Try recycling a freed block of sufficient size
            for blk in self._blocks.values():
                if not blk.allocated and blk.size >= size:
                    blk.allocated  = True
                    blk.owner      = owner
                    blk.tag        = tag
                    blk.zero()
                    blk.last_access = time.monotonic()
                    self._alloc_count += 1
                    return Pointer(self, blk.address)
            # Align next address
            mask = align - 1
            addr = (self._next_addr + mask) & ~mask
            if addr + size > self.total_size:
                raise MemoryError(
                    f"Out of memory: requested {size}, "
                    f"available {self.total_size - self._next_addr}")
            blk = MemoryBlock(addr, size, owner, tag)
            self._blocks[addr] = blk
            self._next_addr = addr + size + 8   # 8-byte guard gap
            self._alloc_count += 1
            cur_used = sum(b.size for b in self._blocks.values() if b.allocated)
            if cur_used > self._peak_bytes:
                self._peak_bytes = cur_used
            return Pointer(self, addr)

    def calloc(self, count: int, size: int,
               owner: str = "user") -> Pointer:
        """Allocate count×size zero-initialised bytes."""
        ptr = self.malloc(count * size, owner)
        blk = self._find_block(ptr.address)
        blk.zero()
        return ptr

    def realloc(self, ptr: Pointer, new_size: int) -> Pointer:
        """Resize allocation. Copies old data, frees old block."""
        with self._lock:
            old_blk = self._find_block(ptr.address)
            if old_blk is None:
                raise MemoryError(f"realloc: invalid pointer {ptr}")
            new_ptr = self.malloc(new_size, old_blk.owner, old_blk.tag)
            new_blk = self._find_block(new_ptr.address)
            copy_len = min(old_blk.size, new_size)
            new_blk.write_bytes(0, old_blk.read_bytes(0, copy_len))
            self.free(ptr)
            return new_ptr

    def free(self, ptr: Pointer) -> None:
        """Mark block as free (zeroed); pointer becomes dangling."""
        if ptr.is_null:
            return
        with self._lock:
            blk = self._blocks.get(ptr.address)
            if blk and blk.allocated:
                blk.allocated = False
                blk.zero()
                self._free_count += 1

    # ══════════════════════════════════════════════════════════════════════
    # Raw read/write (used by Pointer)
    # ══════════════════════════════════════════════════════════════════════

    def _find_block(self, address: int) -> Optional[MemoryBlock]:
        for blk in self._blocks.values():
            if blk.allocated and blk.address <= address < blk.address + blk.size:
                return blk
        return None

    def read(self, address: int, size: int = 1):
        if address == NULL_ADDRESS:
            raise MemoryError("NULL pointer read")
        with self._lock:
            blk = self._find_block(address)
            if blk is None:
                raise MemoryError(f"Invalid read at 0x{address:08x}")
            return blk.read(address - blk.address, size)

    def write(self, address: int, value, size: int = 1) -> None:
        if address == NULL_ADDRESS:
            raise MemoryError("NULL pointer write")
        with self._lock:
            blk = self._find_block(address)
            if blk is None:
                raise MemoryError(f"Invalid write at 0x{address:08x}")
            blk.write(address - blk.address, value, size)

    # ══════════════════════════════════════════════════════════════════════
    # Garbage collection
    # ══════════════════════════════════════════════════════════════════════

    def gc(self, max_age: float = 3600.0) -> int:
        """Free allocated blocks not accessed within max_age seconds."""
        freed = 0
        with self._lock:
            for blk in self._blocks.values():
                if blk.allocated and blk.age() > max_age:
                    blk.allocated = False
                    blk.zero()
                    freed += 1
                    self._free_count += 1
        return freed

    def gc_by_owner(self, owner: str) -> int:
        """Free all blocks belonging to owner."""
        freed = 0
        with self._lock:
            for blk in self._blocks.values():
                if blk.allocated and blk.owner == owner:
                    blk.allocated = False
                    blk.zero()
                    freed += 1
                    self._free_count += 1
        return freed

    def gc_tagged(self, tag: str) -> int:
        """Free all blocks with given tag."""
        freed = 0
        with self._lock:
            for blk in self._blocks.values():
                if blk.allocated and blk.tag == tag:
                    blk.allocated = False
                    blk.zero()
                    freed += 1
        return freed

    def compact(self) -> None:
        """Remove freed block metadata to reclaim dict entries."""
        with self._lock:
            self._blocks = {a: b for a, b in self._blocks.items() if b.allocated}

    # ══════════════════════════════════════════════════════════════════════
    # Inspection
    # ══════════════════════════════════════════════════════════════════════

    def dump(self, address: int, length: int = 64) -> str:
        parts: List[str] = []
        for i in range(length):
            try:
                parts.append(f"{self.read(address + i):02x}")
            except MemoryError:
                parts.append("??")
        # Format as 16-byte rows
        rows = []
        for r in range(0, len(parts), 16):
            row = parts[r:r+16]
            hex_part  = " ".join(row)
            ascii_part = "".join(chr(int(b, 16)) if int(b, 16) in range(32, 127)
                                  else "." for b in row if b != "??")
            rows.append(f"0x{address+r:08x}:  {hex_part:<48}  {ascii_part}")
        return "\n".join(rows)

    def blocks_by_owner(self, owner: str) -> List[MemoryBlock]:
        with self._lock:
            return [b for b in self._blocks.values()
                    if b.allocated and b.owner == owner]

    def fragmentation(self) -> float:
        """Fragmentation ratio: free_holes / total_space (0=none, 1=max)."""
        with self._lock:
            allocated = sum(b.size for b in self._blocks.values() if b.allocated)
            free_holes = len([b for b in self._blocks.values() if not b.allocated])
            total_blocks = len(self._blocks)
            if total_blocks == 0:
                return 0.0
            return free_holes / total_blocks

    def stats(self) -> Dict:
        with self._lock:
            alloc_blocks = [b for b in self._blocks.values() if b.allocated]
            free_blocks  = [b for b in self._blocks.values() if not b.allocated]
            allocated    = sum(b.size for b in alloc_blocks)
            free_space   = self.total_size - allocated
            return {
                "total_bytes":      self.total_size,
                "allocated_bytes":  allocated,
                "free_bytes":       free_space,
                "utilization":      allocated / self.total_size if self.total_size else 0,
                "live_blocks":      len(alloc_blocks),
                "free_blocks":      len(free_blocks),
                "total_allocs":     self._alloc_count,
                "total_frees":      self._free_count,
                "peak_bytes":       self._peak_bytes,
                "fragmentation":    round(self.fragmentation(), 4),
                "next_addr":        f"0x{self._next_addr:08x}",
            }

    # ══════════════════════════════════════════════════════════════════════
    # Snapshot / restore
    # ══════════════════════════════════════════════════════════════════════

    def snapshot(self) -> bytes:
        """Serialise all live blocks to compressed bytes."""
        import pickle
        with self._lock:
            data = {
                "blocks": {
                    addr: {
                        "size": b.size, "data": bytes(b.data),
                        "owner": b.owner, "tag": b.tag,
                        "protection": b.protection,
                    }
                    for addr, b in self._blocks.items() if b.allocated
                },
                "next_addr":  self._next_addr,
                "total_size": self.total_size,
            }
        return zlib.compress(pickle.dumps(data), level=6)

    def restore(self, snapshot: bytes) -> None:
        """Restore memory space from a snapshot."""
        import pickle
        data = pickle.loads(zlib.decompress(snapshot))
        with self._lock:
            self._blocks.clear()
            for addr, info in data["blocks"].items():
                blk = MemoryBlock(addr, info["size"],
                                  info["owner"], info["tag"])
                blk.data       = bytearray(info["data"])
                blk.protection = info["protection"]
                self._blocks[addr] = blk
            self._next_addr = data["next_addr"]

    # ══════════════════════════════════════════════════════════════════════
    # Convenience pointer factories
    # ══════════════════════════════════════════════════════════════════════

    def null_pointer(self) -> Pointer:
        return Pointer(self, NULL_ADDRESS)

    def pointer_to(self, address: int, element_size: int = 1,
                   type_name: str = "u8") -> Pointer:
        return Pointer(self, address, element_size, type_name)

    @staticmethod
    def sizeof(type_name: str) -> int:
        sizes = {"i8":1,"u8":1,"i16":2,"u16":2,"i32":4,"u32":4,
                 "i64":8,"u64":8,"f32":4,"f64":8,"ptr":8}
        return sizes.get(type_name, 1)
