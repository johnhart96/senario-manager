'use strict';

// Renders build/icon.svg to build/icon.png (1024x1024) using Electron itself, so no
// image tooling is needed. electron-builder derives the .ico/.icns from the PNG.
// Run with: npm run icon

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const SIZE = 1024;
const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
const out = path.join(__dirname, '..', 'build', 'icon.png');

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
  app.quit();
});
