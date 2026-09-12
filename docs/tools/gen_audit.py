"""Generate docs/aiui-audit.md from a fresh inventory JSON.

Every applicable row is BLOCKED: no RUNNER/STUDIO/DEVICE-signed evidence
exists for this revision. The generator only turns the scanner ledger into
the exact matrix shape the skill's validator expects.
"""
import json
import sys

inventory_path, out_path = sys.argv[1], sys.argv[2]
inv = json.load(open(inventory_path, encoding="utf-8"))

COMMIT = "88e70bb0382525c1a93ef077c2401dcc31a273ce"
BLOB = f"https://github.com/yodaos-project/AIUI/blob/{COMMIT}"
TREE = f"https://github.com/yodaos-project/AIUI/tree/{COMMIT}"
VERSION = "AIUI 0.17.0"

REASON = {
    "SOURCE": "no source-inspection capture manifest for the current revision",
    "STATIC": "no RUNNER-signed schema-2 manifest for the current revision",
    "LOGIC": "no RUNNER-signed schema-2 manifest for the current revision",
    "AIX": "aix pack/list/preview were executed locally without a RUNNER-signed capture manifest",
    "STUDIO": "no STUDIO-signed capture manifest for the current revision",
    "DEVICE": "no physical Rokid Glasses session for the current revision",
}

UX_ROWS = [
    ("UX-TARGET", "all-targets", "Every supported `_current`, `_blank`, and transition",
     "Wrong density, host behavior, or business-state drift",
     "{contract=ux-target-v1} Exercise each declared surface and target change with the same input",
     ["LOGIC", "STUDIO", "DEVICE"], "Attach target-specific output"),
    ("UX-STATE", "all-states",
     "Every loading, empty, ready, active, success, error, denied, and recovery state used by the product",
     "Hidden, misleading, or dead-end states",
     "{contract=ux-state-v1} Reach each state and every legal and illegal transition",
     ["LOGIC", "AIX", "STUDIO", "DEVICE"], "Attach state trace and render"),
    ("UX-TEXT", "boundary-text",
     "Empty, minimum, maximum, long Chinese/English, mixed Unicode, and malformed input",
     "Clipping, unreadable wrapping, unsafe interpolation, or hidden actions",
     "{contract=ux-text-v1} Exercise boundary values, overflow, scrolling, and fixed-action visibility",
     ["LOGIC", "AIX", "STUDIO", "DEVICE"], "Attach cases and captures"),
    ("UX-FOCUS", "focus-model", "Host and every actionable element",
     "Invisible focus, focus trap, or unfocused activation",
     "{contract=ux-focus-v1} Exercise host focus/blur, element focus/blur, order, activation, and return",
     ["STATIC", "STUDIO", "DEVICE"], "Attach focus trace or video"),
]
UX_INPUT = ("One claimed tap, Enter, Back, directional, touchpad, voice, or gesture path",
            "Double action, stolen host default, unsupported event, or no fallback",
            "{contract=ux-input-v1} Exercise owned and ignored input, default prevention, and a non-sensor fallback",
            ["LOGIC", "STUDIO", "DEVICE"], "Attach event/action trace")
UX_ROWS_TAIL = [
    ("UX-RECOVERY", "failure-recovery",
     "Offline, timeout, denied, unavailable, invalid, and retry states that apply",
     "Silent failure or endless retry",
     "{contract=ux-recovery-v1} Force each failure, verify useful feedback, bounded retry, back/finish, and recovery",
     ["STATIC", "LOGIC", "STUDIO", "DEVICE"], "Attach failure/recovery trace"),
    ("UX-LIFECYCLE", "page-lifecycle",
     "First open, hide/show, unload/reopen, and repeated attach/open where applicable",
     "Stale state, duplicate work, leaked timers/listeners, or wrong resume",
     "{contract=ux-lifecycle-v1} Exercise lifecycle ordering, state reconciliation, and cleanup",
     ["LOGIC", "STUDIO", "DEVICE"], "Attach lifecycle trace"),
    ("UX-VISUAL", "visual-system", "Every meaningful state and focus level",
     "Meaning conveyed only by green luminance, weak hierarchy, excess fill, or clutter",
     "{contract=ux-visual-v1} Check labels/shapes plus luminance, typography, spacing, line weight, fill, and information density",
     ["STATIC", "AIX", "DEVICE"], "Attach annotated captures"),
    ("UX-ENVIRONMENT", "optical-scenes", "Runtime viewport and bright, dark, and cluttered real scenes",
     "Desktop-readable UI fails in physical optics",
     "{contract=ux-environment-v1} Inspect the actual viewport, comfortable region, backgrounds, posture, and motion",
     ["AIX", "DEVICE"], "Attach viewport and glasses evidence"),
    ("UX-MOTION", "motion-performance", "Transitions, animation, repeated navigation, and continuous use",
     "Distraction, unsupported motion, dropped frames, heat, or instability",
     "{contract=ux-motion-v1} Exercise reduced/absent motion fallback, overlap, cold start, and endurance as applicable",
     ["LOGIC", "STUDIO", "DEVICE"], "Attach timing/performance evidence"),
]

FAMILY = {
    "input.head-gesture": dict(
        base="CAP-HEAD-GESTURE",
        layers=["SOURCE", "STATIC", "LOGIC", "STUDIO", "DEVICE"],
        source=f"DOC=[official documentation]({BLOB}/documentation/3-api/framework/page.en-US.md); "
               f"SAMPLE=[official sample]({BLOB}/samples/capabilities/pages/head-gesture/index.ink)",
        contract="cap-input-head-gesture-v1",
        pos="One supported head gesture invokes the owned action exactly once",
        neg="Ignored, unavailable, repeated, and unsupported gestures preserve a non-sensor fallback",
        life="Hide/show and unload remove or reconcile gesture subscriptions and awareness state"),
    "page.world-awareness": dict(
        base="CAP-WORLD-AWARENESS",
        layers=["SOURCE", "STATIC", "LOGIC", "STUDIO", "DEVICE"],
        source=f"DOC=[official documentation]({BLOB}/documentation/3-api/framework/page.en-US.md); "
               f"SAMPLE=[official sample]({BLOB}/samples/capabilities/pages/head-gesture/index.ink)",
        contract="cap-page-world-awareness-v1",
        pos="World awareness enables only for the owned Page and intended interaction",
        neg="Unsupported, denied, or unavailable awareness preserves a non-sensor fallback",
        life="Hide/show and unload disable or reconcile every awareness subscription"),
    "input.key.unknown": dict(
        base="CAP-INPUT-KEY", label="Unresolved key input",
        layers=["SOURCE", "STATIC", "LOGIC", "STUDIO", "DEVICE"],
        source=f"DOC=[official documentation]({BLOB}/documentation/1-framework/open-agent-format/page-events.en-US.md)",
        contract="cap-input-key-unknown-v1",
        pos="The intended key input performs exactly one owned action",
        neg="Unknown, ignored, or repeated key delivery preserves host defaults and a non-key fallback",
        life="Hide/show and unload do not retain stale key handling"),
    "input.voice.unknown": dict(
        base="CAP-VOICE", label="Unresolved voice input",
        layers=["SOURCE", "STATIC", "LOGIC", "STUDIO", "DEVICE"],
        source=f"SEARCH-SCOPE=[search scope]({TREE}/documentation/1-framework/open-agent-format); "
               f"SEARCH-SCOPE=[search scope]({TREE}/documentation/3-api/ai)",
        contract="cap-input-voice-unknown-v1",
        pos="The declared product intent is delivered once",
        neg="No-match, unavailable, repeated, and ignored input use a non-voice fallback",
        life="Hide/show and unload do not retain stale voice work"),
    "media.camera.permission": dict(
        base="CAP-CAMERA-PERMISSION",
        layers=["SOURCE", "STATIC", "STUDIO", "DEVICE"],
        source=f"DOC=[official documentation]({BLOB}/documentation/3-api/media/media-capture.en-US.md); "
               f"DECLARATION-SNIPPET=[CAMERA permission line 57]({BLOB}/samples/capabilities/app.json#L57)",
        contract="cap-media-camera-permission-v1",
        pos="The declared CAMERA permission matches the camera behavior used by the project",
        neg="Missing, denied, or revoked permission preserves an explicit non-camera fallback",
        life="Reopen reconciles the current permission state without assuming prior access"),
    "page.lifecycle": dict(
        base="CAP-PAGE-LIFECYCLE",
        layers=["SOURCE", "STATIC", "LOGIC", "AIX", "STUDIO", "DEVICE"],
        source=f"DOC=[official documentation]({BLOB}/documentation/3-api/framework/page.en-US.md)",
        contract="cap-page-lifecycle-v1",
        pos="Page callbacks establish the intended state once in documented lifecycle order",
        neg="Repeated, interrupted, and out-of-date work cannot overwrite the current Page state",
        life="Hide/show and unload reconcile or release all Page-owned retained work"),
    "page.route": dict(
        base="CAP-PAGE-ROUTE",
        layers=["SOURCE", "STATIC", "LOGIC", "AIX", "STUDIO"],
        source=f"DOC=[official documentation]({BLOB}/documentation/1-framework/open-agent-format/app-json.en-US.md)",
        contract="cap-page-route-v1",
        pos="The declared route opens exactly one intended Page",
        neg="Missing, malformed, or rejected navigation preserves a usable exit",
        life="Repeated navigation and unload leave no stale route-owned work"),
    "project.unregistered": dict(
        base="CAP-UNREGISTERED", label="Unregistered project capability",
        layers=["SOURCE", "STATIC", "LOGIC", "AIX", "STUDIO", "DEVICE"],
        source=f"SEARCH-SCOPE=[search scope]({TREE}/documentation); SEARCH-SCOPE=[search scope]({TREE}/samples)",
        contract="cap-project-unregistered-v1",
        pos="The declared capability performs its claimed outcome once",
        neg="Unavailable, rejected, or ignored delivery preserves an explicit fallback",
        life="Hide/show and unload do not retain stale capability work"),
}


def blocked(layers):
    return "; ".join(f"{layer}=blocked:{REASON[layer]}" for layer in layers)


surfaces = ",".join(sorted(inv["supportedSurfaces"]))
input_gates = sorted(inv["inputGates"], key=lambda g: g["gate"])
inputs_ledger = ",".join(sorted(f"{g['kind']}@{g['gate']}" for g in inv["inputGates"])) or "none"
claimed = ",".join(sorted(inv["claimedCapabilities"]))

lines = [
    f"Project revision: {inv['projectRevision']}",
    f"Canonical version: {VERSION}",
    "Import root: agent",
    "Device/host: UNAVAILABLE",
    f"Supported surfaces: {surfaces}",
    f"Inputs: {inputs_ledger}",
    f"Claimed capabilities: {claimed}",
    "",
    "## Project UX evidence matrix",
    "",
    "| ID | Surface/state | Risk | Test | Evidence layer | Result | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
]
ux_ids = []
for uid, gate, surface, risk, test, layers, _ in UX_ROWS:
    ux_ids.append((uid, layers))
    lines.append(f"| [{uid}] {{gate={gate}}} | {surface} | {risk} | {test} | {', '.join(layers)} | BLOCKED | {blocked(layers)} |")
for index, g in enumerate(input_gates, start=1):
    uid = f"UX-INPUT-GATE{index}"
    ux_ids.append((uid, UX_INPUT[3]))
    lines.append(f"| [{uid}] {{gate={g['gate']}}} | {UX_INPUT[0]} | {UX_INPUT[1]} | {UX_INPUT[2]} | {', '.join(UX_INPUT[3])} | BLOCKED | {blocked(UX_INPUT[3])} |")
for uid, gate, surface, risk, test, layers, _ in UX_ROWS_TAIL:
    ux_ids.append((uid, layers))
    lines.append(f"| [{uid}] {{gate={gate}}} | {surface} | {risk} | {test} | {', '.join(layers)} | BLOCKED | {blocked(layers)} |")

lines += ["", "## Per-capability matrix", "",
          "| Capability | Version/device/surface | API/component/event | Declaration/permission | Official source/sample | Positive path | Negative/fallback path | Lifecycle/cleanup | Evidence layer | Result | Evidence |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]

cap_rows = []
for item in inv["items"]:
    fam = item["family"]
    policy = FAMILY[fam]
    gate = item["gate"]
    key = gate.split("-")[-1].upper()
    provisional = item["policyState"] == "binding-unresolved"
    rid = f"{policy['base']}-{key}" + ("-PROVISIONAL" if provisional else "")
    loc = item["locations"][0]
    mech = item["mechanism"]
    if provisional and "label" in policy:
        label = policy["label"]
    elif "label" in policy:
        label = policy["label"]
    else:
        label = f"{mech} at {loc['path']}:{loc['line']}"
    if provisional and "label" not in policy:
        label = f"{mech} at {loc['path']}:{loc['line']}"
    if mech.startswith("CLAIM:"):
        surface_cell = mech.split("@", 1)[1].split(":", 1)[0]
    else:
        surface_cell = surfaces
    if provisional:
        api = "PROJECT-BINDING:UNRESOLVED"
        decl = "PROJECT-BINDING:UNRESOLVED"
    elif fam == "project.unregistered":
        api = item["apiBinding"]
        decl = "UNKNOWN — source policy not registered"
    else:
        api = item["apiBinding"]
        decl = item["declarationBinding"]
    c = policy["contract"]
    layers = policy["layers"]
    cap_rows.append((rid, layers))
    lines.append(
        f"| [{rid}] {{family={fam}}} {{gate={gate}}} {label} | {VERSION}; device=UNAVAILABLE; surface={surface_cell} | {api} | {decl} | {policy['source']} | "
        f"{{contract={c}}} {{path=positive}} {policy['pos']} | {{contract={c}}} {{path=negative-fallback}} {policy['neg']} | {{contract={c}}} {{path=lifecycle-cleanup}} {policy['life']} | "
        f"{', '.join(layers)} | BLOCKED | {blocked(layers)} |")

all_rows = ux_ids + cap_rows
blocked_ids = sorted(rid for rid, _ in all_rows)
gates = sorted(f"{rid}@{layer}" for rid, layers in all_rows for layer in layers)
lines += ["", "## Final release decision", "",
          "Final status: BLOCKED",
          "Release-ready: NO",
          f"Reason: FAIL=[none]; BLOCKED=[{','.join(blocked_ids)}]",
          f"Required gates: {','.join(gates)}", ""]

with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
    fh.write("\n".join(lines))
print(f"wrote {out_path}: {len(ux_ids)} UX rows, {len(cap_rows)} capability rows")
