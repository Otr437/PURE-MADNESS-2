"""
apps/cli/main.py — interactive REPL for the MathEngine.

Usage:
    python apps/cli/main.py

Commands (at the >>> prompt):
    <expression>             evaluate a mathematical expression
    solve <equation>         solve equation (god-mode)
    prove <statement>        attempt a proof sketch
    derivative <expr> <var> [at <point>]
    integral <expr> <var> <a> <b>
    analyze <n1,n2,…>        descriptive statistics
    train <n1,n2,…>          train prediction model
    predict <n1,n2,…> [steps <n>]
    montecarlo <n1,n2,…> [steps <n>] [sims <n>]
    random [low|medium|high]
    discover                 auto-discover a theorem
    stats                    engine statistics
    memory                   memory stats
    help                     show this help
    exit / quit              exit REPL
"""

import json
import sys
import time
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO))

from core import MathEngine


_HELP = __doc__


def _parse_floats(s: str):
    return [float(x.strip()) for x in s.split(",") if x.strip()]


def repl(engine: MathEngine) -> None:
    print("\n" + "=" * 50)
    print("  Math Engine CLI — type 'help' for commands")
    print("=" * 50 + "\n")

    while True:
        try:
            line = input(">>> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye!")
            break

        if not line:
            continue

        lo = line.lower()

        if lo in ("exit", "quit"):
            print("Bye!")
            break

        elif lo == "help":
            print(_HELP)

        elif lo == "stats":
            print(json.dumps(engine.get_stats(), indent=2, default=str))

        elif lo == "memory":
            print(json.dumps(engine.memory.stats(), indent=2))

        elif lo == "discover":
            r = engine.god_mode.discover_theorem()
            print(f"  Name:      {r.get('name')}")
            print(f"  Statement: {r.get('statement')}")
            print(f"  Confidence:{r.get('confidence', 0):.3f}")

        elif lo.startswith("solve "):
            eq = line[6:].strip()
            r  = engine.solve(eq)
            _pp(r)

        elif lo.startswith("prove "):
            stmt = line[6:].strip()
            r    = engine.prove(stmt)
            _pp(r)

        elif lo.startswith("derivative "):
            parts = line.split()
            # derivative <expr> <var> [at <point>]
            try:
                expr = parts[1]
                var  = parts[2] if len(parts) > 2 else "x"
                pt   = float(parts[4]) if len(parts) > 4 and parts[3].lower() == "at" else 0.0
                r    = engine.derivative(expr, var, pt)
                print(f"  d/d{var} [{expr}] at {pt} = {r}")
            except Exception as e:
                print(f"  Error: {e}")

        elif lo.startswith("integral "):
            parts = line.split()
            try:
                expr = parts[1]; var = parts[2]; a = float(parts[3]); b = float(parts[4])
                r    = engine.integral(expr, var, a, b)
                print(f"  ∫_{a}^{b} {expr} d{var} = {r}")
            except Exception as e:
                print(f"  Error: {e}")

        elif lo.startswith("analyze "):
            data = _parse_floats(line[8:])
            _pp(engine.analyze(data))

        elif lo.startswith("train "):
            data = _parse_floats(line[6:])
            _pp(engine.train_predictive(data))

        elif lo.startswith("predict "):
            rest  = line[8:].strip()
            steps = 5
            if " steps " in rest:
                rest, _, s = rest.rpartition(" steps ")
                steps = int(s.strip())
            data = _parse_floats(rest)
            r    = engine.predict(data, steps)
            preds = r.get("predictions", {}).get("ensemble", [])
            print(f"  Ensemble forecast ({steps} steps): {[round(p,4) for p in preds]}")

        elif lo.startswith("montecarlo "):
            rest  = line[11:].strip()
            steps = 5; n_sims = 500
            if " sims " in rest:
                rest, _, s = rest.rpartition(" sims ")
                n_sims = int(s.strip())
            if " steps " in rest:
                rest, _, s = rest.rpartition(" steps ")
                steps = int(s.strip())
            data = _parse_floats(rest)
            r    = engine.monte_carlo(data, steps, n_sims)
            print("  Monte Carlo forecast:")
            for i in range(steps):
                print(f"    t+{i+1}: mean={r['mean'][i]:.4f}  "
                      f"95% CI [{r['lower_95'][i]:.4f}, {r['upper_95'][i]:.4f}]")

        elif lo.startswith("random"):
            parts = lo.split()
            cplx  = parts[1] if len(parts) > 1 else "medium"
            r     = engine.random_math(cplx)
            print(f"  Expression: {r['expression']}")
            print(f"  Result:     {r['result']}")

        else:
            # Default: evaluate as expression
            t0 = time.time()
            r  = engine.evaluate(line)
            dt = (time.time() - t0) * 1000
            if r.get("result") is not None:
                print(f"  = {r['result']}  ({dt:.1f} ms, confidence={r.get('confidence',1):.2f})")
            else:
                print(f"  Could not evaluate: {line}")


def _pp(obj) -> None:
    print(json.dumps(obj, indent=2, default=str))


def main() -> None:
    engine = MathEngine()
    try:
        repl(engine)
    finally:
        engine.stop()


if __name__ == "__main__":
    main()

# ── Extended REPL commands ─────────────────────────────────────────────────

def _extended_commands(line: str, engine) -> Optional[str]:
    """
    Handle all extended REPL commands not covered in the base repl().
    Returns output string or None if command not matched.
    """
    lo = line.lower().strip()

    # ── Symbolic ops ──────────────────────────────────────────────────────
    if lo.startswith("simplify "):
        r = engine.symbolic_simplify(line[9:].strip())
        return json.dumps(r, indent=2, default=str)

    if lo.startswith("factor "):
        r = engine.factor(line[7:].strip())
        return json.dumps(r, indent=2, default=str)

    if lo.startswith("expand "):
        r = engine.expand(line[7:].strip())
        return json.dumps(r, indent=2, default=str)

    if lo.startswith("series "):
        # series <expr> [var=x] [point=0] [order=6]
        parts = line[7:].strip().split()
        expr  = parts[0]
        var   = "x"; pt = 0; order = 6
        for p in parts[1:]:
            if p.startswith("var="):   var   = p[4:]
            if p.startswith("point="): pt    = int(p[6:])
            if p.startswith("order="): order = int(p[6:])
        r = engine.series_expansion(expr, var, pt, order)
        return json.dumps(r, indent=2, default=str)

    if lo.startswith("diff "):
        # diff <expr> [var=x] [order=1]
        parts = line[5:].strip().split()
        expr  = parts[0]; var = "x"; order = 1
        for p in parts[1:]:
            if p.startswith("var="):   var   = p[4:]
            if p.startswith("order="): order = int(p[6:])
        r = engine.symbolic_diff(expr, var, order)
        return json.dumps(r, indent=2, default=str)

    if lo.startswith("integrate "):
        # integrate <expr> [var=x] [lower=0] [upper=1]
        parts = line[10:].strip().split()
        expr  = parts[0]; var = "x"; lower = None; upper = None
        for p in parts[1:]:
            if p.startswith("var="):   var   = p[4:]
            if p.startswith("lower="): lower = float(p[6:])
            if p.startswith("upper="): upper = float(p[6:])
        r = engine.symbolic_integrate(expr, var, lower, upper)
        return json.dumps(r, indent=2, default=str)

    if lo.startswith("limit "):
        # limit <expr> <var> <point> [left|right|both]
        parts = line[6:].strip().split()
        if len(parts) >= 3:
            expr  = parts[0]; var = parts[1]; point = float(parts[2])
            dirn  = parts[3] if len(parts) > 3 else "both"
            val   = engine.limit(expr, var, point, dirn)
            return f"  lim({var}→{point}) {expr} = {val}"

    if lo.startswith("roots "):
        # roots <expr> [var=x] [lo=-100] [hi=100]
        parts = line[6:].strip().split()
        expr  = parts[0]; var = "x"; lo_ = -100; hi_ = 100
        for p in parts[1:]:
            if p.startswith("var="): var  = p[4:]
            if p.startswith("lo="):  lo_  = float(p[3:])
            if p.startswith("hi="):  hi_  = float(p[3:])
        roots = engine.find_roots(expr, var, lo_, hi_)
        return f"  Roots of {expr}: {[round(r,8) for r in roots]}"

    if lo.startswith("critical "):
        expr = line[9:].strip()
        pts  = engine.critical_points(expr)
        return json.dumps(pts, indent=2, default=str)

    if lo.startswith("classify "):
        expr = line[9:].strip()
        return json.dumps(engine.classify_expression(expr), indent=2)

    # ── Unit conversion ───────────────────────────────────────────────────
    if lo.startswith("convert "):
        # convert <value> <from> to <to>
        # e.g.: convert 100 km to mi
        parts = line[8:].strip().split()
        if len(parts) >= 4 and parts[2].lower() == "to":
            try:
                val  = float(parts[0])
                from_ = parts[1]; to_ = parts[3]
                result = engine.convert_unit(val, from_, to_)
                return f"  {val} {from_} = {result} {to_}"
            except Exception as e:
                return f"  Error: {e}"

    # ── Statistics ────────────────────────────────────────────────────────
    if lo.startswith("regression "):
        # regression x1,x2,... y1,y2,...
        parts = line[11:].strip().split()
        if len(parts) >= 2:
            try:
                x = [float(v) for v in parts[0].split(",")]
                y = [float(v) for v in parts[1].split(",")]
                return json.dumps(engine.regression(x, y), indent=2)
            except Exception as e:
                return f"  Error: {e}"

    if lo.startswith("correlate "):
        parts = line[10:].strip().split()
        if len(parts) >= 2:
            try:
                x = [float(v) for v in parts[0].split(",")]
                y = [float(v) for v in parts[1].split(",")]
                return json.dumps(engine.correlation(x, y), indent=2)
            except Exception as e:
                return f"  Error: {e}"

    # ── Prediction extras ─────────────────────────────────────────────────
    if lo.startswith("forecast "):
        # forecast <data> steps <n>
        rest  = line[9:].strip()
        steps = 5
        if " steps " in rest:
            rest, _, s = rest.rpartition(" steps ")
            steps = int(s.strip())
        data = _parse_floats(rest)
        r    = engine.forecast_intervals(data, steps)
        print("  Bootstrap Prediction Intervals:")
        for i in range(min(steps, len(r.get("median", [])))):
            print(f"    t+{i+1}: {r['lower_95'][i]:.4f} … "
                  f"{r['median'][i]:.4f} … {r['upper_95'][i]:.4f}  (95% CI)")
        return ""

    if lo.startswith("crossval "):
        rest  = line[9:].strip()
        folds = 5
        if " folds " in rest:
            rest, _, f = rest.rpartition(" folds ")
            folds = int(f.strip())
        data = _parse_floats(rest)
        return json.dumps(engine.cross_validate(data, folds), indent=2)

    # ── Crypto / RNG ──────────────────────────────────────────────────────
    if lo.startswith("token"):
        parts = lo.split()
        n     = int(parts[1]) if len(parts) > 1 else 32
        return f"  {engine.random_token(n)}"

    if lo == "rng health" or lo == "rng":
        return json.dumps(engine.rng_health(), indent=2)

    if lo.startswith("walk"):
        parts = lo.split()
        steps = int(parts[1]) if len(parts) > 1 else 20
        path  = engine.random_walk(steps, dims=1)
        vals  = [round(p[0], 4) for p in path]
        return f"  Walk ({steps} steps): {vals}"

    # ── Polynomial ────────────────────────────────────────────────────────
    if lo.startswith("randpoly"):
        parts = lo.split()
        deg   = int(parts[1]) if len(parts) > 1 else 3
        poly  = engine.rng.random_polynomial(deg)
        r     = engine.evaluate(poly)
        return f"  Poly: {poly}\n  At x=0: {r['result']}"

    # ── Prove ─────────────────────────────────────────────────────────────
    if lo.startswith("prove "):
        stmt = line[6:].strip()
        r    = engine.prove(stmt)
        from packages.god_mode import GodModeEngine
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
            import importlib.util as _ilu
            spec = _ilu.spec_from_file_location(
                "god_mode",
                str(Path(__file__).resolve().parents[2] / "packages" / "god-mode" / "__init__.py"))
            mod  = _ilu.module_from_spec(spec); spec.loader.exec_module(mod)
            ps   = mod.GodModeEngine  # access ProofStandards if needed
        except Exception:
            pass
        print(f"  Proved: {r.get('proved')}")
        for step in r.get("steps", []):
            print(f"    {step}")
        return ""

    # ── DB / system ───────────────────────────────────────────────────────
    if lo == "db stats":
        return json.dumps(engine.db.get_stats(), indent=2)

    if lo == "db audit":
        rows = engine.db.get_audit_log(limit=10)
        return json.dumps(rows[-10:], indent=2, default=str)

    if lo == "memory":
        return json.dumps(engine.memory.stats(), indent=2)

    if lo.startswith("memory gc"):
        freed = engine.memory.gc()
        return f"  GC freed {freed} blocks"

    if lo == "config":
        cfg = engine.config.to_dict()
        return json.dumps(cfg, indent=2, default=str)

    if lo.startswith("config set "):
        parts = line[11:].strip().split("=", 1)
        if len(parts) == 2:
            engine.config.set(parts[0].strip(), parts[1].strip())
            return f"  Set {parts[0].strip()} = {parts[1].strip()}"

    return None   # not matched


# ── Security: CLI input sanitisation ─────────────────────────────────────

class CLISecurityLayer:
    """
    Guards the CLI REPL against injection and resource abuse.
    All user input passes through here before reaching the engine.
    """
    MAX_LINE_LEN    = 16_384
    MAX_BATCH_ITEMS = 200
    BLOCKED_SHELL   = frozenset(["os.system","subprocess","__import__",
                                  "exec(","eval(","open(","socket"])

    @classmethod
    def sanitise_line(cls, line: str) -> str:
        if len(line) > cls.MAX_LINE_LEN:
            raise ValueError(f"Input too long ({len(line)} chars)")
        lo = line.lower()
        for tok in cls.BLOCKED_SHELL:
            if tok in lo:
                raise ValueError(f"Blocked token: '{tok}'")
        return line

    @classmethod
    def safe_parse_floats(cls, s: str,
                           max_items: int = 100_000) -> List[float]:
        parts = [p.strip() for p in s.split(",") if p.strip()]
        if len(parts) > max_items:
            raise ValueError(f"Too many values: {len(parts)} > {max_items}")
        result = []
        for p in parts:
            try:
                result.append(float(p))
            except ValueError:
                raise ValueError(f"Invalid float: '{p}'")
        return result

    @classmethod
    def validate_command_arg(cls, arg: str,
                              allowed_pattern: str = r"[\w\.\-\+\*/\^=\(\)\s,]+") -> str:
        import re
        if not re.match(f"^{allowed_pattern}$", arg):
            raise ValueError(f"Argument contains disallowed characters: '{arg}'")
        return arg


# ── Standards: REPL output formatting ────────────────────────────────────

class REPLOutputStandards:
    """
    Consistent, readable REPL output following Unix CLI conventions:
      - Errors on stderr with [ERROR] prefix
      - Warnings with [WARN] prefix
      - Results indented 2 spaces
      - Numbers formatted to 8 significant figures max
      - Long lists truncated with count shown
    """
    MAX_LIST_DISPLAY = 20
    SIG_FIGS         = 8

    @staticmethod
    def format_result(label: str, value: Any) -> str:
        import math
        if isinstance(value, float):
            if math.isnan(value):  return f"  {label}: NaN"
            if math.isinf(value):  return f"  {label}: {'∞' if value > 0 else '-∞'}"
            return f"  {label}: {round(value, REPLOutputStandards.SIG_FIGS)}"
        if isinstance(value, complex):
            return (f"  {label}: {round(value.real,6)}"
                    f" + {round(value.imag,6)}i")
        if isinstance(value, list):
            if len(value) > REPLOutputStandards.MAX_LIST_DISPLAY:
                preview = value[:REPLOutputStandards.MAX_LIST_DISPLAY]
                return (f"  {label}: [{', '.join(str(v) for v in preview)}"
                        f" … ({len(value)} total)]")
            return f"  {label}: {value}"
        return f"  {label}: {value}"

    @staticmethod
    def error(msg: str) -> str:
        return f"[ERROR] {msg}"

    @staticmethod
    def warn(msg: str) -> str:
        return f"[WARN]  {msg}"

    @staticmethod
    def section(title: str) -> str:
        bar = "─" * min(len(title) + 4, 60)
        return f"\n{bar}\n  {title}\n{bar}"

    @staticmethod
    def timing(elapsed_ms: float) -> str:
        if elapsed_ms < 1:     return f"({elapsed_ms*1000:.1f} μs)"
        if elapsed_ms < 1000:  return f"({elapsed_ms:.1f} ms)"
        return f"({elapsed_ms/1000:.2f} s)"

    @staticmethod
    def confidence(c: float) -> str:
        label = ("✓ Certain" if c >= 0.95 else
                 "~ Likely"  if c >= 0.75 else
                 "? Unsure"  if c >= 0.50 else
                 "✗ Speculative")
        return f"[{label} {c:.0%}]"


# ── Patch repl() to use extended commands ────────────────────────────────

_original_repl = repl

def repl(engine) -> None:
    """Extended REPL wrapping the base repl with all new commands."""
    sec = CLISecurityLayer()
    fmt = REPLOutputStandards()

    print(REPLOutputStandards.section("Math Engine CLI — Extended"))
    print("  New commands: simplify, factor, expand, series, diff, integrate,")
    print("  limit, roots, critical, classify, convert, regression, correlate,")
    print("  forecast, crossval, token, rng, walk, randpoly, prove,")
    print("  db stats, db audit, memory, config, config set")
    print("  (all base commands still work)\n")

    while True:
        try:
            raw = input(">>> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye!")
            break

        if not raw:
            continue

        lo = raw.lower()
        if lo in ("exit", "quit"):
            print("Bye!"); break

        # Security sanitise first
        try:
            raw = sec.sanitise_line(raw)
        except ValueError as e:
            print(fmt.error(str(e))); continue

        # Try extended commands
        try:
            out = _extended_commands(raw, engine)
        except Exception as e:
            print(fmt.error(str(e))); continue

        if out is not None:
            if out:
                print(out)
            continue

        # Fall back to base commands
        if lo == "help":
            print(__doc__); continue
        if lo == "stats":
            print(json.dumps(engine.get_stats(), indent=2, default=str)); continue
        if lo.startswith("analyze "):
            data = _parse_floats(raw[8:])
            print(json.dumps(engine.analyze(data), indent=2)); continue
        if lo.startswith("train "):
            data = _parse_floats(raw[6:])
            print(json.dumps(engine.train_predictive(data), indent=2)); continue
        if lo.startswith("predict "):
            rest = raw[8:].strip(); steps = 5
            if " steps " in rest:
                rest, _, s = rest.rpartition(" steps "); steps = int(s)
            data = _parse_floats(rest)
            r    = engine.predict(data, steps)
            preds = r.get("predictions",{}).get("ensemble",[])
            print(f"  Ensemble: {[round(p,4) for p in preds]}"); continue
        if lo.startswith("random"):
            parts = lo.split()
            cplx  = parts[1] if len(parts) > 1 else "medium"
            r     = engine.random_math(cplx)
            print(f"  Expr:   {r['expression']}")
            print(f"  Result: {r['result']}"); continue

        # Default: evaluate
        import time as _time
        t0  = _time.time()
        try:
            r = engine.evaluate(raw)
        except Exception as e:
            print(fmt.error(str(e))); continue
        dt  = (_time.time() - t0) * 1000
        if r.get("result") is not None:
            conf = r.get("confidence", 1.0)
            print(f"  = {r['result']}  "
                  f"{fmt.timing(dt)}  {fmt.confidence(conf)}")
        else:
            print(fmt.error(f"Could not evaluate: {raw}"))
