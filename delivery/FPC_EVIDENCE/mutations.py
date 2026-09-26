import subprocess, shutil
M = [
 ('F-11','deployer/lib/release.mjs',"    if (fs.lstatSync(link).isSymbolicLink()) fs.mkdirSync(","    if (false) fs.mkdirSync(",'deployer/test/release-gate.test.mjs','F-11'),
 ('E-05','deployer/lib/gates/run.mjs',"&& dep0 !== dep1;","|| true;",'deployer/test/gates-proofs.test.mjs','E-05'),
 ('E-06','deployer/lib/gates/run.mjs',"xy.length === 2 && xy.every","xy.every",'deployer/test/gates-proofs.test.mjs','E-06'),
 ('E-10','deployer/lib/gates/run.mjs',"    for (const id of all) {","    for (const id of [X, Y]) {",'deployer/test/gates-proofs.test.mjs','E-10'),
 ('D-08','deployer/lib/commands.mjs',"if (consumers.some(c => c !== names.consumer(env, d.id))) throw","if (false) throw",'deployer/test/e2e-failclosed.test.mjs','D-08'),
 ('D-09','deployer/lib/render.mjs',"h.update(text.split(edgeDir).join('<EDGE_DIR>'));","h.update(text);",'deployer/test/render.test.mjs','D-09'),
 ('H-15','deployer/lib/prod.mjs',"  await localChecks({ cfg, env: 'prod', wrangler: createWrangler({ quiet: true }), dryRun: false, inContainer: !!process.env.KAWA_IN_CONTAINER });  // H-15","  // removed H-15",'deployer/test/e2e-cutover-rotate.test.mjs','H-15'),
 ('R3-04','deployer/lib/evidence.mjs',"  if (!/^[0-9a-f]{64}$/.test(got)) return false;\n  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));","  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));",'deployer/test/release-integrity.test.mjs','R3-04'),
 ('R3-10','deployer/lib/release.mjs',"const key = (n) => (root ? path.relative(root, n) : path.basename(n));","const key = (n) => path.basename(n);",'deployer/test/release-gate.test.mjs','R3-10'),
 ('R3-11','deployer/lib/zip.mjs',"if (type !== 0 && type !== 0o100000) throw","if (false) throw",'deployer/test/release-integrity.test.mjs','R3-11'),
 ('R3-12','deployer/lib/manifest.mjs',"const excluded = TOOL_DIRS.has(r) ||","const excluded = TOOL_DIRS.has(e.name) ||",'deployer/test/release-integrity.test.mjs','R3-12'),
 ('R3-13','deployer/lib/gates/run.mjs',"  if (dx.last_error) return","  if (false) return",'deployer/test/gates-proofs.test.mjs','R3-13'),
 ('R3-14','deployer/lib/release.mjs',"if (hasEvidenceKey() && (!kid || kid === localKeyId())) {","if (hasEvidenceKey()) {",'deployer/test/release-integrity.test.mjs','R3-14'),
 ('R3-15','kawa-edge','[ ! -L "$0" ] || {','false && {','deployer/test/launcher.test.mjs','R3-15'),
 ('R3-16','deployer/lib/evidence.mjs',"['kawa-edge', path.join(path.dirname(DEPLOYER_DIR), 'kawa-edge')], ","",'deployer/test/release.test.mjs','R3-16'),
]
for id_, f, a, b, t, pat in M:
    orig = open(f).read(); assert a in orig, (id_, a)
    open(f,'w').write(orig.replace(a,b,1))
    try:
        r = subprocess.run(['node','--test','--test-name-pattern',pat,t],capture_output=True,text=True,timeout=600)
        fails = [l for l in r.stdout.splitlines() if l.startswith('not ok')]
        print(f"{id_:6} correction reverted -> {'DETECTED' if r.returncode!=0 else 'NOT DETECTED'} ({len(fails)} failing)")
    finally:
        open(f,'w').write(orig)
