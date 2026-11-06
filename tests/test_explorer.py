"""The morphology atlas hands Draft ordinary robot directories.

The atlas's decoder and exporter are JavaScript (they run in the page), so
these tests drive them with Node and compile what they write with the real
generator. A design may be refused by the feasibility gate (that is the gate's
job, and the atlas never runs it), but it must never be malformed, and every
body must sit where the atlas drew it.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import mujoco
import numpy as np
import pytest

import draft.explorer
from draft.explorer.server import _design_files
from draft.generation.generator import RobotGenerator
from draft.trends.feasibility import FeasibilityViolation

WEB = Path(draft.explorer.__file__).parent / "web"
NODE = shutil.which("node")

_EXPORT = r"""
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const [web, out, n, seed] = process.argv.slice(1);
const G = await import(pathToFileURL(`${web}/genome.js`).href);
const X = await import(pathToFileURL(`${web}/draft_export.js`).href);
const world = new G.World(Number(seed));
const rand = G.mulberry32(7);
const rows = [];
for (let i = 0; i < Number(n); i++) {
  const d = G.decode(world.latentAt((rand() - 0.5) * 300, (rand() - 0.5) * 300));
  const ex = X.toDraft(d, 'test');
  fs.mkdirSync(`${out}/${ex.name}`, { recursive: true });
  for (const [f, t] of Object.entries(ex.files)) fs.writeFileSync(`${out}/${ex.name}/${f}`, t);
  const bodies = {};
  G.walk(d, (node, R, p) => { bodies[node.name] = [p[0], p[1], p[2] + d.standHeight]; });
  rows.push({ name: ex.name, bodies, r: d.classes.L.r, len: d.classes.L.len });
}
console.log(JSON.stringify(rows));
"""


def _export(tmp: Path, n: int, seed: int) -> list[dict]:
    res = subprocess.run([NODE, "--input-type=module", "-e", _EXPORT, str(WEB), str(tmp), str(n), str(seed)],
                         capture_output=True, text=True, timeout=120, check=True)
    return json.loads(res.stdout)


@pytest.mark.skipif(NODE is None, reason="needs Node to run the atlas's JavaScript")
def test_every_exported_design_compiles_or_is_refused_by_the_gate(tmp_path):
    rows = _export(tmp_path / "robots", n=10, seed=3)
    compiled = 0
    for row in rows:
        src = tmp_path / "robots" / row["name"]
        out = tmp_path / "out" / row["name"]
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                RobotGenerator(src).generate(out)
        except FeasibilityViolation:
            continue            # the gate's verdict, which the atlas defers
        compiled += 1
        xml = next(out.rglob(f"{row['name']}.xml"))
        model = mujoco.MjModel.from_xml_path(str(xml))
        data = mujoco.MjData(model)
        mujoco.mj_kinematics(model, data)
        for body, pos in row["bodies"].items():
            bid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, body)
            assert bid >= 0, f"{row['name']}: {body} missing from the compiled model"
            # Written at 5 decimals, so a few hundredths of a millimetre.
            np.testing.assert_allclose(data.xpos[bid], pos, atol=2e-4,
                                       err_msg=f"{row['name']}: {body} is not where the atlas drew it")
        resolved = (next(out.rglob("parameters_resolved.yaml"))).read_text()
        assert "L_motor_r" in resolved
    assert compiled >= len(rows) // 2, f"only {compiled} of {len(rows)} designs compiled"


@pytest.mark.skipif(NODE is None, reason="needs Node to run the atlas's JavaScript")
def test_the_atlas_draws_actuators_at_the_size_draft_gives_them(tmp_path):
    """The page draws actuators with the same fitted relations the generator uses."""
    import yaml

    row = _export(tmp_path / "robots", n=1, seed=11)[0]
    out = tmp_path / "out"
    try:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            RobotGenerator(tmp_path / "robots" / row["name"]).generate(out)
    except FeasibilityViolation:
        pytest.skip("this sample is refused by the gate; sizes are only resolved for compiled designs")
    res = yaml.safe_load(next(out.rglob("parameters_resolved.yaml")).read_text())
    assert res["L_motor_r"] == pytest.approx(row["r"], rel=0.01)
    assert res["L_motor_L"] == pytest.approx(row["len"], rel=0.01)


@pytest.mark.parametrize("name", ["humanoid", "../evil", "atlas_../x", "atlas_A", ""])
def test_the_local_server_writes_only_atlas_designs(name):
    files = {"parameters.yaml": "", "tree.yaml": "", "mesh.yaml": ""}
    with pytest.raises(ValueError):
        _design_files({"name": name, "files": files})


def test_the_local_server_takes_exactly_the_three_files():
    with pytest.raises(ValueError):
        _design_files({"name": "atlas_abc12", "files": {"tree.yaml": "", "../x.yaml": ""}})
    name, files = _design_files({"name": "atlas_abc12",
                                 "files": {"parameters.yaml": "a", "tree.yaml": "b", "mesh.yaml": "c"}})
    assert name == "atlas_abc12" and set(files) == {"parameters.yaml", "tree.yaml", "mesh.yaml"}
