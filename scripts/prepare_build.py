#!/usr/bin/env python3
import json
import os
import re
import shutil
import sys
import xml.sax.saxutils as sax
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "android-template"
BUILD_ID = sys.argv[1] if len(sys.argv) > 1 else ""
if not re.fullmatch(r"[0-9a-fA-F-]{20,40}", BUILD_ID):
    raise SystemExit("Invalid build ID")

request_dir = ROOT / "build-requests" / BUILD_ID
config_path = request_dir / "config.json"
if not config_path.is_file():
    raise SystemExit("Build request not found")

cfg = json.loads(config_path.read_text(encoding="utf-8"))
app_name = str(cfg.get("appName", "My App")).strip()[:50] or "My App"
package_name = str(cfg.get("packageName", "com.dapp.myapp")).strip()
if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,5}", package_name):
    raise SystemExit("Invalid Android package name")
version = str(cfg.get("version", "1.0")).strip()[:30] or "1.0"
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,29}", version):
    raise SystemExit("Invalid version string")
source_type = cfg.get("sourceType", "url")
url = str(cfg.get("url", "")).strip()
orientation = cfg.get("orientation", "sensor")
if orientation not in ("sensor", "portrait", "landscape"):
    orientation = "sensor"

workspace = ROOT / "build-workspace"
if workspace.exists():
    shutil.rmtree(workspace)
shutil.copytree(TEMPLATE, workspace)

app_dir = workspace / "app"
manifest = app_dir / "src/main/AndroidManifest.xml"
manifest_text = manifest.read_text(encoding="utf-8")
permissions = []
perms = cfg.get("permissions") or {}
if perms.get("internet", True) or source_type == "url":
    permissions.append('<uses-permission android:name="android.permission.INTERNET" />')
if perms.get("camera"):
    permissions.append('<uses-permission android:name="android.permission.CAMERA" />')
if perms.get("location"):
    permissions.append('<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />')
    permissions.append('<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />')
manifest_text = manifest_text.replace("@@PERMISSIONS@@", "\n    ".join(permissions))
manifest_text = manifest_text.replace("@@ORIENTATION@@", orientation)
manifest_text = manifest_text.replace("@@APP_NAME@@", sax.escape(app_name, {'"': '&quot;'}))
manifest.write_text(manifest_text, encoding="utf-8")

build_gradle = app_dir / "build.gradle"
gradle_text = build_gradle.read_text(encoding="utf-8")
gradle_text = gradle_text.replace("@@PACKAGE_NAME@@", package_name)
gradle_text = gradle_text.replace("@@VERSION_NAME@@", version.replace('\\', '\\\\').replace('"', '\\"'))
build_gradle.write_text(gradle_text, encoding="utf-8")

strings = app_dir / "src/main/res/values/strings.xml"
strings.write_text('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">' + sax.escape(app_name) + '</string>\n</resources>\n', encoding="utf-8")

assets = app_dir / "src/main/assets"
assets.mkdir(parents=True, exist_ok=True)
(assets / "config.json").write_text(json.dumps({
    "sourceType": source_type,
    "url": url,
    "fullscreen": bool(cfg.get("fullscreen")),
    "keepScreenOn": bool(cfg.get("keepScreenOn")),
}, ensure_ascii=False), encoding="utf-8")

if source_type == "html":
    html_file = request_dir / "index.html"
    if not html_file.is_file():
        raise SystemExit("HTML source missing")
    shutil.copyfile(html_file, assets / "index.html")

icon = request_dir / "icon.png"
if icon.is_file():
    import subprocess
    manifest_text = manifest.read_text(encoding="utf-8").replace("@android:drawable/sym_def_app_icon", "@mipmap/ic_launcher")
    manifest.write_text(manifest_text, encoding="utf-8")
    mipmap = app_dir / "src/main/res"
    for density, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        out_dir = mipmap / ("mipmap-" + density)
        out_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(["convert", str(icon), "-resize", f"{size}x{size}", str(out_dir / "ic_launcher.png")], check=True)

print(f"Prepared {app_name} ({package_name})")
