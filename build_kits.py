#!/usr/bin/env python3
"""Pack drum samples into kits.js for Thump, and write CREDITS.md.

Sources: the .h2drumkit archives in sources/ (Hydrogen drum kits: the two that
shipped with Hydrogen plus ones downloaded from Hydrogen's kit library).

Kits in EXTRA have no license stated anywhere, so they are not in the public
repository. If their archives are in sources/extra/, the build writes them to
kits-extra.js (git-ignored), which the app loads when it is there. Presets only
use the public kits.
Every sample is re-encoded to mono Ogg Opus and embedded as base64 so the
page runs from a file:// URL with no server. Instruments with many velocity
layers keep at most three (soft, medium, hard).

Sound ids are smp:<pack>:<slug of the original instrument name>. Presets and
saved beats refer to these ids, so never rename a pack id.

Run: python3 build_kits.py
"""
import base64
import json
import re
import subprocess
import sys
import tarfile
import tempfile
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "kits.js"
OUT_EXTRA = HERE / "kits-extra.js"
EXTRA_DIR = HERE / "sources" / "extra"
CREDITS = HERE / "CREDITS.md"

# pack id: (display name, archive name in sources/, author, license if the kit doesn't say)
PACKS = {
    "rock":      ("Rock kit", "GMRockKit", "Glen MacArthur / Sebastian Moors", "GPL"),
    "808":       ("808 kit", "TR808EmulationKit", "Artemiy Pavlov", "GPL"),
    "tr":        ("808 & 909", "TR808909", "Artemiy Pavlov", ""),
    "techno":    ("Techno", "Techno-1", "Artemiy Pavlov", ""),
    "hard":      ("Hard Electro", "HardElectro1", "Artemiy Pavlov", ""),
    "empire":    ("Electric Empire", "ElectricEmpireKit", "Artemiy Pavlov", ""),
    "trash":     ("Trash kit", "K-27_Trash_Kit", "Michael Wolkstein", ""),
    "metal":     ("Metal kit", "DeathMetal", "Archman", ""),
    "hiphop":    ("Hip-hop", "HipHop-1", "Artemiy Pavlov", ""),
    "audiophob": ("Audiophob", "Audiophob", "Audiophob (soundcloud.com/audiophobdubstep)", "CC0"),
    "synthie":   ("Synthie", "Synthie-1", "Artemiy Pavlov", ""),
    "vari":      ("VariBreaks", "VariBreaks", "Artemiy Pavlov", ""),
    "626":       ("TR-626", "Classic-626", "Artemiy Pavlov", "GPL-2 (LICENCE file in the kit)"),
    "dr110":     ("DR-110", "Boss_DR-110", "Artemiy Pavlov", ""),
    "boxes":     ("Classic boxes", "3355606kit", "Artemiy Pavlov", ""),
    "denon":     ("Denon CRB-90", "DenonCRB-90", "Thijs Van Severen", "CC-BY-SA"),
    "td7":       ("TD-7", "TD-7kit", "Artemiy Pavlov", ""),
    "hiphop2":   ("Hip-hop 2", "HipHop-2", "Artemiy Pavlov", ""),
    "eastern":   ("Eastern hop", "EasternHop-1", "Artemiy Pavlov", ""),
    "hands":     ("Gimme a hand", "GimmeAHand", "Glen MacArthur", "GPL"),
    "erny":      ("Erny's percussion", "ErnysPercussion", "Erny", ""),
    "africa":    ("circAfrique", "circAfrique", "Jim Harney", "CC-BY-SA 3.0"),
}

# No license stated in the kit or anywhere else we could find: local only.
EXTRA = {"tr", "techno", "hiphop", "synthie", "dr110", "boxes", "td7", "hiphop2", "eastern", "erny"}

CATEGORY_RULES = [
    ("clap", r"clap|snap"),
    ("world", r"conga|bongo|djembe|sangban|dununba|kenkeni|tabla|cajon|timbale"),
    ("perc", r"cowb|\bcow\b|clave|shaker|marac|whistle|click|drum \d|tamb|agogo|guiro|cabasa|vibra|coffe|woodblock|waterglass|gamelan|perc"),
    ("kick", r"kick|\bbd\b|x-over|bass drum"),
    ("snare", r"snare|\bsd\b|\bsn\b|rim|stick"),
    ("hat", r"hat|\bhh\b|chh|ohh"),
    ("cymbal", r"crash|ride|splash|china|cymbal|\bcym\b|bell"),
    ("tom", r"tom|\bt\b"),
    ("bass", r"bass"),
    ("fx", r"fx|zap|hit|scratch|blip|sweep|shape"),
]
# Sounds the name rules get wrong: (pack, slug) -> category
CATEGORY_FIX = {
    ("synthie", "hard-909"): "kick", ("synthie", "sim-synth"): "stab", ("synthie", "am-sine-bell"): "stab",
    ("synthie", "am-drum-1"): "tom", ("synthie", "am-drum-2"): "tom", ("hiphop2", "fx-kick"): "kick",
}
# Pack names repeated inside instrument names.
STRIP = [r"^Classic-626[ _]", r"^DR-110 ", r"^VariBreaks ", r"[ _]*Denon\b"]
TOKENS = {"bd": "Kick", "sd": "Snare", "sn": "Snare", "chh": "Closed hat", "ohh": "Open hat",
          "hh": "Hat", "marac": "Maracas", "cowb": "Cowbell", "cow": "Cowbell", "fx": "FX",
          "op": "Open", "cl": "Closed", "pd": "Pedal", "nz": "Noise", "x": "X", "t": "Tom",
          "cym": "Cymbal", "tamb": "Tambourine", "am": "AM", "xp909": "XP909", "juno6": "Juno-6"}


def category(pack: str, name: str) -> str:
    fix = CATEGORY_FIX.get((pack, slug(name)))
    if fix:
        return fix
    low = name.lower()
    for cat, rx in CATEGORY_RULES:
        if re.search(rx, low):
            return cat
    return "perc"


def clean(name: str) -> str:
    for rx in STRIP:
        name = re.sub(rx, "", name)
    name = re.sub(r"\((manual|patterns)\)", r"\1", name)
    words = [w for w in re.split(r"[\s_]+", name.replace(" - ", " ").replace("-", " ")) if w]
    words = [TOKENS.get(w.lower(), w.capitalize() if w.islower() else w) for w in words]
    return " ".join(words)


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def encode(path: Path) -> str:
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-t", "4",
           "-af", "afade=t=out:st=3.6:d=0.4", "-ac", "1",
           "-c:a", "libopus", "-b:a", "64k", "-f", "ogg", "-"]
    data = subprocess.run(cmd, check=True, capture_output=True).stdout
    return base64.b64encode(data).decode("ascii")


def strip_ns(root: ET.Element) -> None:
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]


def read_kit(kit_dir: Path):
    root = ET.parse(kit_dir / "drumkit.xml").getroot()
    strip_ns(root)
    lic = (root.findtext("license") or "").strip()
    instruments = []
    for ins in root.iter("instrument"):
        name = (ins.findtext("name") or "").strip()
        layers = []
        for layer in ins.iter("layer"):
            fn = layer.findtext("filename")
            mx = float(layer.findtext("max") or 1)
            if fn and (kit_dir / fn).is_file():
                layers.append((mx, kit_dir / fn))
        fn = ins.findtext("filename")
        if not layers and fn and (kit_dir / fn).is_file():
            layers.append((1.0, kit_dir / fn))
        if name and layers:
            instruments.append((name, sorted(layers)))
    return lic, instruments


def pick_layers(layers):
    if len(layers) <= 3:
        return layers
    mid = len(layers) // 2
    keep = [layers[0], layers[mid], layers[-1]]
    # Re-spread the velocity ranges over the three kept layers.
    return [(1 / 3, keep[0][1]), (2 / 3, keep[1][1]), (1.0, keep[2][1])]


def archive_for(pid: str) -> Path:
    return (EXTRA_DIR if pid in EXTRA else HERE / "sources") / f"{PACKS[pid][1]}.h2drumkit"


def kit_dir_for(archive: Path, tmp: Path) -> Path:
    dest = tmp / archive.stem
    with tarfile.open(archive) as t:
        t.extractall(dest, filter="data")
    return next(dest.rglob("drumkit.xml")).parent


def build(pids, tmp: Path, pool):
    packs, sounds, credits = [], [], []
    for pid in pids:
        title, src, author, lic_default = PACKS[pid]
        lic, instruments = read_kit(kit_dir_for(archive_for(pid), tmp))
        lic = lic or lic_default or "not stated in the kit (Hydrogen kit library)"
        seen = set()
        for name, layers in instruments:
            sid = f"smp:{pid}:{slug(name)}"
            if sid in seen:
                continue
            seen.add(sid)
            picked = pick_layers(layers)
            sounds.append({
                "id": sid, "name": clean(name), "cat": category(pid, name), "pack": pid,
                "layers": [{"max": round(mx, 4), "data": pool.submit(encode, f)} for mx, f in picked],
            })
        packs.append({"id": pid, "title": title})
        credits.append((title, src, author, lic, len(seen)))
        print(f"{title:18} {len(seen):3} sounds{'  (extra)' if pid in EXTRA else ''}")
    for s in sounds:
        for layer in s["layers"]:
            layer["data"] = layer["data"].result()
    return {"packs": packs, "sounds": sounds}, credits


def main() -> None:
    public = [p for p in PACKS if p not in EXTRA]
    extra = [p for p in PACKS if p in EXTRA and archive_for(p).is_file()]
    with tempfile.TemporaryDirectory() as tmp, ThreadPoolExecutor(8) as pool:
        data, credits = build(public, Path(tmp), pool)
        xdata, xcredits = build(extra, Path(tmp), pool) if extra else (None, [])
    OUT.write_text("// Generated by build_kits.py. Samples from Hydrogen drum kits; see CREDITS.md.\n"
                   "window.THUMP_SAMPLES = " + json.dumps(data, separators=(",", ":")) + ";\n")
    rows = "\n".join(f"| {t} | {s} | {a} | {lic} | {n} |" for t, s, a, lic, n in credits)
    CREDITS.write_text(
        "# Credits\n\nSynth sounds in `synth.js` are original to Thump.\n\n"
        "Drum samples in `kits.js` are re-encoded from Hydrogen drum kits (from Hydrogen itself and\n"
        "its online kit library on SourceForge and hydro.smoors.de). Each kit keeps its own license,\n"
        "listed below; the original kit archives are in `sources/`. Generated by build_kits.py.\n\n"
        "| Kit in Thump | Hydrogen kit | Author | License | Sounds |\n|---|---|---|---|---|\n" + rows + "\n")
    n = len(data["sounds"])
    print(f"{n} sounds, wrote {OUT.name} ({OUT.stat().st_size // 1024} KiB) and {CREDITS.name}")
    if xdata:
        head = "".join(f"// {t}: {s} by {a}, license {lic}\n" for t, s, a, lic, _ in xcredits)
        OUT_EXTRA.write_text(
            "// Generated by build_kits.py. Extra kits kept out of the public repository because\n"
            "// their licenses are not stated. Personal use only.\n" + head +
            "(function (S, X) { S.packs.push(...X.packs); S.sounds.push(...X.sounds); })(window.THUMP_SAMPLES, "
            + json.dumps(xdata, separators=(",", ":")) + ");\n")
        print(f"{len(xdata['sounds'])} extra sounds, wrote {OUT_EXTRA.name} ({OUT_EXTRA.stat().st_size // 1024} KiB)")
    elif OUT_EXTRA.exists():
        OUT_EXTRA.unlink()


if __name__ == "__main__":
    sys.exit(main())
