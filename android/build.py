"""Builds Board Roamer for Android without Gradle.

    python android/build.py                # release APK  -> android/out/BoardRoamer.apk
    python android/build.py --debug        # debuggable (Chrome DevTools can attach) -> android/out/BoardRoamer-debug.apk

Needs the Android SDK (ANDROID_HOME, default C:\\Android\\Sdk) and a JDK. The signing key lives in
android/board-roamer.keystore (created on first run) â€” keep it: updates only install over the old app if signed with it.
"""
import os, shutil, subprocess, sys, zipfile, glob, re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SDK = os.environ.get('ANDROID_HOME') or r'C:\Android\Sdk'
DEBUG = '--debug' in sys.argv
VERSION_NAME = '1.1.1'
VERSION_CODE = 3
MIN_SDK, TARGET_SDK = 29, 34

def pick(path_glob):
    found = sorted(glob.glob(path_glob))
    if not found: sys.exit('missing in the SDK: ' + path_glob)
    return found[-1]

BT = pick(os.path.join(SDK, 'build-tools', '34.*'))
JAR = os.path.join(SDK, 'platforms', f'android-{TARGET_SDK}', 'android.jar')
exe = lambda n: os.path.join(BT, n)
BUILD = os.path.join(HERE, 'build' + ('-debug' if DEBUG else ''))
OUT = os.path.join(HERE, 'out')

def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode:
        print('$', ' '.join(map(str, cmd))); print(r.stdout); print(r.stderr); sys.exit(f'step failed ({r.returncode})')
    return r.stdout

shutil.rmtree(BUILD, ignore_errors=True)
os.makedirs(BUILD); os.makedirs(OUT, exist_ok=True)

# 1. the web app becomes the APK's assets
assets = os.path.join(BUILD, 'assets', 'ui')
shutil.copytree(os.path.join(ROOT, 'ui'), assets, ignore=shutil.ignore_patterns('*.bak', '*.map', '.git*'))
print('assets:', sum(len(f) for _, _, f in os.walk(assets)), 'files')

# 2. manifest (debuggable flag filled in)
man = open(os.path.join(HERE, 'AndroidManifest.xml'), encoding='utf8').read().replace('@DEBUGGABLE@', 'true' if DEBUG else 'false')
manifest = os.path.join(BUILD, 'AndroidManifest.xml')
open(manifest, 'w', encoding='utf8').write(man)

# 3. resources
res_zip = os.path.join(BUILD, 'res.zip')
run([exe('aapt2.exe'), 'compile', '--dir', os.path.join(HERE, 'res'), '-o', res_zip])
base = os.path.join(BUILD, 'base.apk')
run([exe('aapt2.exe'), 'link', '-o', base, '-I', JAR, '--manifest', manifest, '--min-sdk-version', str(MIN_SDK), '--target-sdk-version', str(TARGET_SDK),
     '--version-code', str(VERSION_CODE), '--version-name', VERSION_NAME, '-A', os.path.join(BUILD, 'assets'), res_zip])

# 4. Java -> classes -> dex
classes = os.path.join(BUILD, 'classes'); os.makedirs(classes)
sources = glob.glob(os.path.join(HERE, 'src', '**', '*.java'), recursive=True)
run(['javac', '--release', '11', '-encoding', 'UTF-8', '-Xlint:-options', '-cp', JAR, '-d', classes] + sources)
dexdir = os.path.join(BUILD, 'dex'); os.makedirs(dexdir)
class_files = glob.glob(os.path.join(classes, '**', '*.class'), recursive=True)
run([exe('d8.bat'), '--lib', JAR, '--min-api', str(MIN_SDK), '--output', dexdir] + ([] if not DEBUG else ['--debug']) + (['--release'] if not DEBUG else []) + class_files)

# 5. put classes.dex into the apk (keeping resources.arsc stored, as Android 11+ requires)
merged = os.path.join(BUILD, 'merged.apk')
with zipfile.ZipFile(base) as zin, zipfile.ZipFile(merged, 'w') as zout:
    for item in zin.infolist():
        zout.writestr(item, zin.read(item.filename), compress_type=item.compress_type)
    zout.write(os.path.join(dexdir, 'classes.dex'), 'classes.dex', compress_type=zipfile.ZIP_DEFLATED)

# 6. align + sign
aligned = os.path.join(BUILD, 'aligned.apk')
run([exe('zipalign.exe'), '-p', '-f', '4', merged, aligned])
ks = os.path.join(HERE, 'board-roamer.keystore')
pw = 'boardroamer-local'
if not os.path.exists(ks):
    run(['keytool', '-genkeypair', '-keystore', ks, '-alias', 'boardroamer', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
         '-storepass', pw, '-keypass', pw, '-dname', 'CN=Board Roamer, O=Personal'])
    print('created signing key', ks)
final = os.path.join(OUT, 'BoardRoamer-debug.apk' if DEBUG else 'BoardRoamer.apk')
run([exe('apksigner.bat'), 'sign', '--ks', ks, '--ks-pass', 'pass:' + pw, '--key-pass', 'pass:' + pw, '--ks-key-alias', 'boardroamer', '--out', final, aligned])
print(run([exe('apksigner.bat'), 'verify', '--print-certs', final]).strip().splitlines()[0])
print(f'built {final}  ({os.path.getsize(final)/1024:.0f} KB)')


