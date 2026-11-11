"""Native-only principles never expand the exact pstack source mirror."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "scripts/verify_install.py"
spec = importlib.util.spec_from_file_location("verify_extensions", MODULE)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class NativePrincipleExtensionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pstack-principles-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "pstack"
        source = MODULE.parents[1]
        shutil.copytree(source, self.root, ignore=shutil.ignore_patterns("tests", "__pycache__"))
        for name in ("routes", "poteto-mode"):
            shutil.copytree(source.parent / name, self.root.parent / name)

    def refresh_native(self):
        path = self.root / "native-manifest.json"
        manifest = json.loads(path.read_text())
        for record in manifest["files"]:
            data = (self.root / record["path"]).read_bytes()
            record.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        path.write_text(json.dumps(manifest))

    def declaration(self, mutate):
        path = self.root / "native/principle-extensions.json"
        value = json.loads(path.read_text())
        mutate(value)
        path.write_text(json.dumps(value))
        self.refresh_native()

    def test_declared_native_principle_passes_without_adding_a_mirrored_skill(self):
        result = verifier.verify(self.root)
        self.assertEqual(result["principles"], 25)
        self.assertEqual(result["source"]["files"], 573)
        self.assertEqual(result["principleExtensions"], ["principle-the-algorithm"])
        self.assertFalse((self.root / "upstream/skills/principle-the-algorithm").exists())

    def test_undeclared_principle_still_fails_after_native_hash_refresh(self):
        path = self.root / "native/principles.md"
        path.write_text(path.read_text() + "\n## principle-undeclared\nNot allowed.\n")
        self.refresh_native()
        with self.assertRaisesRegex(verifier.IntegrityError, "native route coverage"):
            verifier.verify(self.root)

    def test_missing_mirrored_workflow_is_not_excused_by_extension(self):
        path = self.root / "native/workflows.md"
        path.write_text(path.read_text().replace("## how\n", "## missing-how\n", 1))
        self.refresh_native()
        with self.assertRaisesRegex(verifier.IntegrityError, "native route coverage"):
            verifier.verify(self.root)

    def test_only_the_reviewed_extension_can_be_declared(self):
        self.declaration(lambda value: value["extensions"][0].update(name="principle-other"))
        with self.assertRaisesRegex(verifier.IntegrityError, "principle extension allowlist"):
            verifier.verify(self.root)

    def test_duplicate_or_missing_declaration_fails(self):
        self.declaration(lambda value: value["extensions"].append(value["extensions"][0]))
        with self.assertRaisesRegex(verifier.IntegrityError, "principle extension allowlist"):
            verifier.verify(self.root)
        self.declaration(lambda value: value.update(extensions=[]))
        with self.assertRaisesRegex(verifier.IntegrityError, "principle extension allowlist"):
            verifier.verify(self.root)

    def test_immutable_source_pin_and_copyright_are_checked(self):
        path = self.root / "native/principle-extensions.json"
        original = path.read_text()
        for field, bad in (("commit", "main"), ("commit", "f" * 40), ("path", "pstack/skills/unslop/SKILL.md"),
                           ("copyright", "Copyright someone else"), ("license", "unknown")):
            with self.subTest(field=field):
                path.write_text(original)
                self.declaration(lambda value: value["extensions"][0].update({field: bad}))
                with self.assertRaisesRegex(verifier.IntegrityError, "principle extension provenance"):
                    verifier.verify(self.root)

    def test_changed_source_or_license_cannot_hide_behind_regenerated_native_hashes(self):
        for name in ("principle-the-algorithm.md", "LICENSE.txt"):
            path = self.root / "native/sources/dyl-stack" / name
            original = path.read_bytes()
            path.write_bytes(original + b"changed")
            self.refresh_native()
            with self.assertRaisesRegex(verifier.IntegrityError, "content mismatch"):
                verifier.verify(self.root)
            path.write_bytes(original)

    def test_source_mirror_remains_exact(self):
        (self.root / "upstream/extra.txt").write_text("Not part of pstack")
        with self.assertRaisesRegex(verifier.IntegrityError, "unexpected source inventory"):
            verifier.verify(self.root)

    def test_order_authority_rerun_citation_and_native_trigger_are_explicit(self):
        text = (self.root / "native/principles.md").read_text()
        section = text.split("## principle-the-algorithm\n")[1].split("\n## ")[0]
        self.assertEqual(re.findall(r"^(\d+)\. ", section, re.M), ["1", "2", "3", "4", "5"])
        for clause in ("person who owns it and their reason", "Disagreement never overrides explicit user or policy requirements",
                       "Delete only within the authorized scope", "Do not remove safeguards, approval or review requirements",
                       "Rerun all five steps on the result before delivery", "its owner and reason", "result of the second pass"):
            self.assertIn(clause, section)
        requirements = json.loads((self.root / "native/requirements/poteto-mode.json").read_text())
        gate = next(g["text"] for g in requirements["gates"] if "principle-the-algorithm" in g["text"])
        self.assertIn(gate, (self.root / "native/workflows.md").read_text())
        self.assertIn("Before designing a nontrivial change", gate)
