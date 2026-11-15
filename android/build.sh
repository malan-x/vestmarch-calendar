#!/usr/bin/env bash
# Сборка «Вестмарш+» голыми инструментами Android SDK (без Gradle): aapt2 → javac → d8 → zipalign → apksigner.
# Нужны ANDROID_HOME (или ANDROID_SDK_ROOT) и JDK. На GitHub Actions всё это уже стоит.
# Подпись: ключ из секретов ANDROID_KEYSTORE_B64 / ANDROID_KEYSTORE_PASS; без них — одноразовый ключ (только для проверки сборки).
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -d "$SDK" ] || { echo "Нет Android SDK (ANDROID_HOME)"; exit 1; }
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | grep -E 'android-[0-9]+$' | sort -V | tail -1)"
JAR="$PLATFORM/android.jar"
API="${PLATFORM##*android-}"
VERSION_CODE="${GITHUB_RUN_NUMBER:-1}"
VERSION_NAME="1.${VERSION_CODE}"
echo "build-tools: $BT"
echo "platform:    $PLATFORM (targetSdk $API), версия $VERSION_NAME ($VERSION_CODE)"

rm -rf build out
mkdir -p build/gen build/classes build/dex out

"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml --java build/gen \
  --min-sdk-version 26 --target-sdk-version "$API" --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  build/res.zip

javac -source 8 -target 8 -encoding UTF-8 -Xlint:-options -bootclasspath "$JAR" -classpath "$JAR" \
  -d build/classes $(find src build/gen -name '*.java')
"$BT/d8" --release --min-api 26 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
(cd build/dex && zip -q ../unsigned.apk classes.dex)

"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk

if [ -n "${ANDROID_KEYSTORE_B64:-}" ] && [ -n "${ANDROID_KEYSTORE_PASS:-}" ]; then
  echo "$ANDROID_KEYSTORE_B64" | base64 -d > build/release.jks
  KS=build/release.jks
  PASS="$ANDROID_KEYSTORE_PASS"
  echo "APK_SIGNED=release" >> "${GITHUB_ENV:-/dev/null}"
else
  echo "ВНИМАНИЕ: нет секретов подписи — подписываю одноразовым ключом, обновлять поверх такой сборки нельзя"
  echo "APK_SIGNED=throwaway" >> "${GITHUB_ENV:-/dev/null}"
  KS=build/throwaway.jks
  PASS=throwaway
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -alias vestmarch -keyalg RSA -keysize 2048 -validity 365 \
    -dname "CN=throwaway" -storepass "$PASS" -keypass "$PASS" >/dev/null
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$PASS" --ks-key-alias vestmarch --key-pass "pass:$PASS" \
  --out out/vestmarch-plus.apk build/aligned.apk
rm -f build/release.jks

"$BT/apksigner" verify --verbose --print-certs out/vestmarch-plus.apk | grep -E 'Verified using|Signer #1 certificate (DN|SHA-256)'
"$BT/aapt2" dump badging out/vestmarch-plus.apk | grep -E "^(package|application-label|sdkVersion|targetSdkVersion|launchable-activity)"
echo "VERSION_NAME=$VERSION_NAME" >> "${GITHUB_ENV:-/dev/null}"
ls -l out/vestmarch-plus.apk
