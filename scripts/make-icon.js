'use strict';

// Renders build/icon.svg to build/icon.png (1024x1024) using Electron itself, so no
// image tooling is needed. electron-builder derives the .ico/.icns from the PNG.
// Also writes build/icons/NxN.png in the standard hicolor sizes for Linux: desktops
// don't look in a 1024x1024 folder, so a single large icon shows up as a generic one.
// Run with: npm run icon

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const SIZE = 1024;
const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
const out = path.join(__dirname, '..', 'build', 'icon.png');
const linuxDir = path.join(__dirname, '..', 'build', 'icons');
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setZoomFactor(1);
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const png = img.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG();
  fs.writeFileSync(out, png);
  console.log(`wrote ${out} (${img.getSize().width}x${img.getSize().height} captured)`);
  fs.mkdirSync(linuxDir, { recursive: true });
  for (const n of LINUX_SIZES) {
    fs.writeFileSync(path.join(linuxDir, `${n}x${n}.png`), img.resize({ width: n, height: n, quality: 'best' }).toPNG());
  }
  console.log(`wrote ${linuxDir}/ (${LINUX_SIZES.join(', ')})`);
  app.quit();
});
