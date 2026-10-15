"""Builds Board Roamer for Android without Gradle.

    python android/build.py                # release APK  -> android/out/BoardRoamer.apk
    python android/build.py --debug        # debuggable (Chrome DevTools can attach) -> android/out/BoardRoamer-debug.apk

Needs the Android SDK (ANDROID_HOME, default C:\\Android\\Sdk) and a JDK. Works on Windows, macOS and Linux.

Signing: an update only installs over an older version if it is signed with the same key. The key is NEVER committed:
    BR_KEYSTORE        path to the keystore file   (default: android/board-roamer.keystore)
    BR_KEYSTORE_PASS   its password                 (default: the first line of android/keystore.pass)
In CI both come from repository secrets. Locally, a missing keystore is created once (with a random password).
Version: BR_VERSION, else the version in Cargo.toml.
"""
import os, shutil, subprocess, sys, zipfile, glob, re, secrets

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SDK = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or r'C:\Android\Sdk'
DEBUG = '--debug' in sys.argv
WIN = os.name == 'nt'


def cargo_version():
    return re.search(r'^version\s*=\s*"([^"]+)"', open(os.path.join(ROOT, 'Cargo.toml'), encoding='utf8').read(), re.M).group(1)


VERSION_NAME = (os.environ.get('BR_VERSION') or cargo_version()).lstrip('v')
_v = [int(x) for x in re.findall(r'\d+', VERSION_NAME)[:3]] + [0, 0, 0]
VERSION_CODE = _v[0] * 10000 + _v[1] * 100 + _v[2]  # 1.3.0 -> 10300: always grows with the version
MIN_SDK, TARGET_SDK = 29, 34


def pick(path_glob):
    found = sorted(glob.glob(path_glob))
    if not found: sys.exit('missing in the SDK: ' + path_glob)
    return found[-1]


BT = pick(os.path.join(SDK, 'build-tools', '34.*'))
JAR = os.path.join(SDK, 'platforms', f'android-{TARGET_SDK}', 'android.jar')


def exe(n):
    # aapt2.exe / d8.bat / apksigner.bat on Windows, plain names elsewhere
    base = {'aapt2': 'aapt2.exe', 'zipalign': 'zipalign.exe', 'd8': 'd8.bat', 'apksigner': 'apksigner.bat'}[n] if WIN else n
    return os.path.join(BT, base)


BUILD = os.path.join(HERE, 'build' + ('-debug' if DEBUG else ''))
OUT = os.path.join(HERE, 'out')


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode:
        print('$', ' '.join(map(str, cmd))); print(r.stdout); print(r.stderr); sys.exit(f'step failed ({r.returncode})')
    return r.stdout


shutil.rmtree(BUILD, ignore_errors=True)
os.makedirs(BUILD); os.makedirs(OUT, exist_ok=True)
print(f'Board Roamer {VERSION_NAME} (versionCode {VERSION_CODE}){" [debug]" if DEBUG else ""}')

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
run([exe('aapt2'), 'compile', '--dir', os.path.join(HERE, 'res'), '-o', res_zip])
base = os.path.join(BUILD, 'base.apk')
run([exe('aapt2'), 'link', '-o', base, '-I', JAR, '--manifest', manifest, '--min-sdk-version', str(MIN_SDK), '--target-sdk-version', str(TARGET_SDK),
     '--version-code', str(VERSION_CODE), '--version-name', VERSION_NAME, '-A', os.path.join(BUILD, 'assets'), res_zip])

# 4. Java -> classes -> dex
classes = os.path.join(BUILD, 'classes'); os.makedirs(classes)
sources = glob.glob(os.path.join(HERE, 'src', '**', '*.java'), recursive=True)
run(['javac', '--release', '11', '-encoding', 'UTF-8', '-Xlint:-options', '-cp', JAR, '-d', classes] + sources)
dexdir = os.path.join(BUILD, 'dex'); os.makedirs(dexdir)
class_files = glob.glob(os.path.join(classes, '**', '*.class'), recursive=True)
run([exe('d8'), '--lib', JAR, '--min-api', str(MIN_SDK), '--output', dexdir] + (['--debug'] if DEBUG else ['--release']) + class_files)

# 5. put classes.dex into the apk (keeping resources.arsc stored, as Android 11+ requires)
merged = os.path.join(BUILD, 'merged.apk')
with zipfile.ZipFile(base) as zin, zipfile.ZipFile(merged, 'w') as zout:
    for item in zin.infolist():
        zout.writestr(item, zin.read(item.filename), compress_type=item.compress_type)
    zout.write(os.path.join(dexdir, 'classes.dex'), 'classes.dex', compress_type=zipfile.ZIP_DEFLATED)

# 6. align + sign
aligned = os.path.join(BUILD, 'aligned.apk')
run([exe('zipalign'), '-p', '-f', '4', merged, aligned])
ks = os.environ.get('BR_KEYSTORE') or os.path.join(HERE, 'board-roamer.keystore')
passfile = os.path.join(HERE, 'keystore.pass')
pw = os.environ.get('BR_KEYSTORE_PASS') or (open(passfile).readline().strip() if os.path.exists(passfile) else '')
if not os.path.exists(ks):
    if os.environ.get('CI') and not os.environ.get('BR_TEMP_KEY'): sys.exit('no signing key in CI: set the ANDROID_KEYSTORE_B64 and ANDROID_KEYSTORE_PASS secrets')
    pw = pw or secrets.token_hex(16)
    run(['keytool', '-genkeypair', '-keystore', ks, '-alias', 'boardroamer', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
         '-storepass', pw, '-keypass', pw, '-dname', 'CN=Board Roamer, O=Tox-EyE-CeaZY'])
    open(passfile, 'w').write(pw + '\n')
    print('created signing key', ks, '(password saved in android/keystore.pass; both are git-ignored, back them up)')
if not pw: sys.exit('no keystore password: set BR_KEYSTORE_PASS or put it in android/keystore.pass')
final = os.path.join(OUT, 'BoardRoamer-debug.apk' if DEBUG else 'BoardRoamer.apk')
run([exe('apksigner'), 'sign', '--ks', ks, '--ks-pass', 'pass:' + pw, '--key-pass', 'pass:' + pw, '--ks-key-alias', 'boardroamer', '--out', final, aligned])
print(run([exe('apksigner'), 'verify', '--print-certs', final]).strip().splitlines()[0])
print(f'built {final}  ({os.path.getsize(final)/1024:.0f} KB)')
