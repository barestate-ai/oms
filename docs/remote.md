# Remote access

`/remote` opens the session you are in to your other devices: a phone, a tablet or another computer. You get the same conversation in a browser, live, and you can send messages, stop work and answer approval questions from there. Nothing leaves your machine for a cloud service: OMS itself serves the page.

## Use it

1. Type `/remote` in OMS. It prints one or more addresses and a code.
2. Open an address on the other device and type the code.
3. OMS asks in the terminal whether that device may connect. Press `y`.

The status row shows `remote` while it is on, and how many devices are connected. `/remote stop` turns it off. Closing OMS turns it off too.

| Command          | What it does                                                    |
| ---------------- | --------------------------------------------------------------- |
| `/remote`        | Turn it on for your network, or show the addresses and the code |
| `/remote local`  | Reachable from this computer only                               |
| `/remote tunnel` | Also open an https address that works from anywhere             |
| `/remote stop`   | Turn it off                                                     |
| `/remote forget` | Unpair every device                                             |

## Install it on a phone

Each session has its own page, name and icon: a small bot picked from the session's id. Add the page to the home screen (Share, then Add to Home Screen on iPhone; the menu, then Add to Home screen on Android) and it opens like an app.

A session keeps the same port, so the installed app still works after you close and reopen OMS: run `/remote` again in that session. The app stops finding the session when your computer's address changes. Use the `.local` name when `/remote` lists one, or a Tailscale address, and it keeps working.

Android only offers a full install over https, which `/remote tunnel` gives. On iPhone, the home-screen app has its own storage, so it asks for the code once more the first time you open it.

## What a remote device can do

- Read the conversation as the terminal shows it. Secrets are masked the same way.
- Send a message to the agent. A message is always sent as text; slash commands are for the terminal.
- Stop the work that is running.
- Answer an approval: once, for the session, or deny. The whole command is shown.

## How it is protected

- The pages themselves say nothing but the session's name. Everything else needs a paired device.
- A device pairs with a code that is used once, and only after you allow it in the terminal. A photo of the code does not pair a second device.
- Ten wrong codes in a minute stop all pairing for that minute.
- Each device makes its own secret. OMS stores only its hash, in the session's folder under `~/.oms`.
- A page on another site cannot post to the server.

The connection on your network is plain http. Anyone who can read the traffic on that network could take over a paired device's access, so use it on networks you trust. Away from home, use a Tailscale address (encrypted between your devices) or `/remote tunnel`.

`/remote tunnel` starts a Cloudflare quick tunnel with `cloudflared`, which you install yourself (`brew install cloudflared`). Traffic then passes through Cloudflare, and the address changes every time, so devices pair again.
