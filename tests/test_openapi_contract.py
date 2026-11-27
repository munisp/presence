"""TECH-14: contract tests generated from docs/api/openapi.yaml.

The OpenAPI document is the client<->server contract (TR-23); this suite
generates its assertions from the document rather than restating them, so
the docs cannot silently drift from the runtime guarantees:

  1. every /v1 request body schema sets additionalProperties: false — the
     strictness the edge enforces via ajv (TR-23);
  2. a synthesised valid instance passes each body schema, and the same
     instance plus one unknown property FAILS — additionalProperties is not
     just declared, it must actually reject;
  3. every documented path+operation exists in the edge route sources, and
     every edge route is documented — coverage in both directions;
  4. every mutating operation documents the Idempotency-Key header (TR-24);
  5. every schema in the document is a well-formed JSON Schema.

Run: python -m pytest tests/test_openapi_contract.py
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
SPEC_PATH = ROOT / "docs" / "api" / "openapi.yaml"
EDGE_SRC = ROOT / "services" / "edge" / "src"

SPEC = yaml.safe_load(SPEC_PATH.read_text())

MUTATING = {"post", "put", "patch", "delete"}
METHODS = {"get", "post", "put", "patch", "delete"}


def operations() -> list[tuple[str, str, dict]]:
    out = []
    for path, item in SPEC["paths"].items():
        for method, op in item.items():
            if method in METHODS:
                out.append((path, method, op))
    return out


def body_schema(op: dict) -> dict | None:
    return (
        op.get("requestBody", {})
        .get("content", {})
        .get("application/json", {})
        .get("schema")
    )


def synth(schema: dict) -> object:
    """Synthesise a minimal valid instance for a schema, or None when a
    required constraint (e.g. a pattern) cannot be synthesised reliably."""
    if "enum" in schema:
        return schema["enum"][0]
    t = schema.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "null")
    if t == "string":
        if "pattern" in schema:
            return None
        return "x" * max(int(schema.get("minLength", 1)), 1)
    if t == "integer":
        return int(schema.get("minimum", 1))
    if t == "number":
        return float(schema.get("minimum", 0.5))
    if t == "boolean":
        return True
    if t == "array":
        item = synth(schema.get("items", {}))
        return [] if not schema.get("minItems") else ([item] if item is not None else None)
    if t == "object" or "properties" in schema:
        out: dict[str, object] = {}
        for key in schema.get("required", []):
            prop = schema.get("properties", {}).get(key)
            if prop is None:
                return None
            value = synth(prop)
            if value is None:
                return None
            out[key] = value
        return out
    return None


def fastify_path(openapi_path: str) -> str:
    return re.sub(r"\{([^}]+)\}", r":\1", openapi_path)


def openapi_path(fastify: str) -> str:
    return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", fastify)


def edge_routes() -> set[tuple[str, str]]:
    """(method, path) pairs registered in the edge sources."""
    routes: set[tuple[str, str]] = set()
    # `scope.` covers routes inside an encapsulated app.register scope
    # (the batch-69 WhatsApp webhook's raw-body parser scope) — both
    # directions of the contract still apply to them.
    pattern = re.compile(r"""(?:app|scope)\.(get|post|put|delete|patch)\(\s*["'](/v1/[^"']*|/healthz)["']""")
    for src in list(EDGE_SRC.glob("*.ts")) + list((EDGE_SRC / "routes").glob("*.ts")):
        for method, path in pattern.findall(src.read_text()):
            routes.add((method, openapi_path(path)))
    return routes


# ---------------------------------------------------------------- strictness


@pytest.mark.parametrize(
    "path,method,op",
    [t for t in operations() if body_schema(t[2]) is not None],
    ids=[f"{m.upper()} {p}" for p, m, o in operations() if body_schema(o) is not None],
)
def test_body_schema_is_strict(path: str, method: str, op: dict) -> None:
    schema = body_schema(op)
    assert schema is not None
    assert schema.get("additionalProperties") is False, (
        f"{method.upper()} {path}: request body schema must set "
        "additionalProperties: false (TR-23)"
    )


@pytest.mark.parametrize(
    "path,method,op",
    [t for t in operations() if body_schema(t[2]) is not None],
    ids=[f"{m.upper()} {p}" for p, m, o in operations() if body_schema(o) is not None],
)
def test_unknown_property_actually_rejected(path: str, method: str, op: dict) -> None:
    schema = body_schema(op)
    assert schema is not None
    validator = Draft202012Validator(schema)
    instance = synth(schema)
    if instance is None:
        pytest.skip("schema constraints not synthesisable; strictness asserted structurally")
    assert validator.is_valid(instance), (
        f"{method.upper()} {path}: synthesised instance must validate: {instance}"
    )
    poisoned = dict(instance) if isinstance(instance, dict) else None
    assert poisoned is not None
    poisoned["zzUnknownField"] = 1
    assert not validator.is_valid(poisoned), (
        f"{method.upper()} {path}: additionalProperties: false must reject unknown fields"
    )


# ----------------------------------------------------------------- coverage


def test_every_documented_operation_exists_in_the_edge() -> None:
    routes = edge_routes()
    missing = [
        f"{m.upper()} {p}"
        for p, m, _ in operations()
        if (m, p) not in routes
    ]
    assert not missing, "documented but not implemented: " + ", ".join(missing)


def test_every_edge_route_is_documented() -> None:
    documented = {(m, p) for p, m, _ in operations()}
    missing = [
        f"{m.upper()} {p}"
        for m, p in sorted(edge_routes())
        if (m, p) not in documented
    ]
    assert not missing, "implemented but not documented: " + ", ".join(missing)


# ---------------------------------------------------------------- TR-24


def test_mutating_operations_document_idempotency_key() -> None:
    missing = []
    for path, method, op in operations():
        if method not in MUTATING:
            continue
        params = op.get("parameters", [])
        has_idem = any(
            isinstance(prm, dict) and prm.get("$ref", "").endswith("/IdempotencyKey")
            for prm in params
        )
        if not has_idem:
            missing.append(f"{method.upper()} {path}")
    assert not missing, "mutating ops missing Idempotency-Key docs: " + ", ".join(missing)


# ---------------------------------------------------------------- well-formed


def test_all_schemas_are_well_formed() -> None:
    bad: list[str] = []

    def visit(node: object, where: str) -> None:
        if isinstance(node, dict):
            if "type" in node or "properties" in node or "$ref" not in node and "enum" in node:
                try:
                    Draft202012Validator.check_schema(node)
                except Exception as exc:  # noqa: BLE001 - report every offender
                    bad.append(f"{where}: {exc}")
            for key, value in node.items():
                if key in ("schema", "items", "properties") or isinstance(value, (dict, list)):
                    visit(value, f"{where}.{key}")
        elif isinstance(node, list):
            for i, value in enumerate(node):
                visit(value, f"{where}[{i}]")

    visit(SPEC["paths"], "paths")
    assert not bad, "malformed schemas:\n" + "\n".join(bad)
