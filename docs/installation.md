# Installation

Download the file for your system from the
[latest release](https://github.com/johnhart96/senario-manager/releases/latest).

| System | File | Notes |
|---|---|---|
| Windows 10/11 (x64 or ARM) | `Senario-Manager-<version>-win-<arch>.exe` | Installer. Choose per-user or a custom folder. |
| Windows, no install | `Senario-Manager-<version>-portable.exe` | Runs from anywhere, e.g. a USB stick. |
| macOS 12+ (Apple Silicon) | `Senario-Manager-<version>-mac-arm64.dmg` | |
| macOS 12+ (Intel) | `Senario-Manager-<version>-mac-x64.dmg` | |
| Ubuntu / Debian | `Senario-Manager-<version>-linux-amd64.deb` | Recommended on Linux. |
| Fedora / RHEL / openSUSE | `Senario-Manager-<version>-linux-x86_64.rpm` | |
| Any Linux | `Senario-Manager-<version>-linux-x86_64.AppImage` | Single file, no install. |

All installed versions register `.senario` files, so double-clicking one opens it in the app.

## Windows

1. Run the installer.
2. Release builds may be unsigned. If Windows SmartScreen says *"Windows protected your PC"*,
   click **More info → Run anyway**.
3. The first time the app starts listening, Windows Defender Firewall asks whether to allow it.
   Allow **Private networks**. For tighter control, add an inbound rule that only allows TCP 25
   from your mail server's IP address:
   ```powershell
   New-NetFirewallRule -DisplayName "Senario Manager SMTP" -Direction Inbound -Protocol TCP `
     -LocalPort 25 -RemoteAddress <mail-server-ip> -Action Allow
   ```

No special rights are needed to listen on port 25 on Windows, but nothing else on the machine
(for example IIS SMTP or another mail server) may already be using it.

## macOS

1. Open the `.dmg` and drag **Senario Manager** to **Applications**.
2. Unsigned builds are blocked by Gatekeeper the first time. Either right-click the app →
   **Open** → **Open**, or run:
   ```bash
   xattr -cr "/Applications/Senario Manager.app"
   ```
3. When macOS asks whether to accept incoming network connections, click **Allow**.

macOS (10.14 and later) lets apps listen on port 25 without administrator rights.

## Linux

### .deb (Ubuntu, Debian, Mint…)

```bash
sudo apt install ./Senario-Manager-<version>-linux-amd64.deb
```

### .rpm (Fedora, RHEL, openSUSE…)

```bash
sudo dnf install ./Senario-Manager-<version>-linux-x86_64.rpm
```

### AppImage

```bash
chmod +x Senario-Manager-<version>-linux-x86_64.AppImage
./Senario-Manager-<version>-linux-x86_64.AppImage
```

On Ubuntu 24.04 and later, AppArmor may stop the AppImage's sandbox from starting. If it exits
immediately, run it with `--no-sandbox`, or use the `.deb` instead, which sets the sandbox up
correctly.

### Allow port 25 (Linux only)

Linux only lets root use ports below 1024. Rather than running the app as root, lower that
limit to 25:

```bash
# now (until reboot)
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=25

# permanently
echo 'net.ipv4.ip_unprivileged_port_start=25' | sudo tee /etc/sysctl.d/60-senario-manager.conf
sudo sysctl --system
```

This lets any program on the machine use ports 25–1023, which is normally fine on a dedicated
lab machine. Alternatively, choose a listener port of 1024 or higher in Settings and point the
mail server's routes at that port.

### Firewall

If `ufw` is active, allow SMTP from the mail server only:

```bash
sudo ufw allow from <mail-server-ip> to any port 25 proto tcp
```

For firewalld:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<mail-server-ip> port port=25 protocol=tcp accept'
sudo firewall-cmd --reload
```

## Running from source

Requires [Node.js](https://nodejs.org) 24 or later and git.

```bash
git clone https://github.com/johnhart96/senario-manager.git
cd senario-manager
npm install
npm start
```

`npm start` works on Windows, macOS and Linux. On Linux you may hit the Chromium sandbox error
described in [Troubleshooting](troubleshooting.md#the-app-wont-start-on-linux-suid-sandbox-helper);
`npm start -- --no-sandbox` works around it on a lab machine.

## Where your data lives

The app keeps its working state (settings, company, conversations and the activity log) here:

| System | Folder |
|---|---|
| Windows | `%APPDATA%\senario-manager` |
| macOS | `~/Library/Application Support/senario-manager` |
| Linux | `~/.config/senario-manager` |

Installed builds and `npm start` share this folder. The OpenAI API key and SMTP password are
encrypted with the operating system's keychain where available. Save to a
[`.senario` file](senario-file-format.md) to keep a scenario somewhere else or share it.

## Uninstalling

Use your system's normal uninstall method. The data folder above is left in place; delete it
too if you want to remove all scenarios and settings.

## Next steps

- [Set up the mail server](mail-server-setup.md)
- [Walk through the app](user-guide.md)
