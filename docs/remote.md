# Remote access and sharing

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

## Share a session with a teammate

`/share` invites someone else into the session. It turns remote access on if it was off and prints a link.

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `/share`               | Share this session, or show the link and who is here      |
| `/share stop`          | End the sharing and remove every guest                    |
| `/sync`                | Trade what is new with a teammate who has their own copy  |
| `oms join '<link>'`    | In a shell: take a copy of a shared session and open it   |

The link works two ways.

**In a browser.** Your teammate sees your session live and can send messages to your agent. Their messages reach the agent marked with their name. They cannot stop work, and they never see or answer approval questions: those stay with you. While YOLO is on, guests can only watch, because a message could then run anything on your computer unseen.

**With their own OMS.** `oms join '<link>'` in their project folder gives them their own copy of the conversation. They continue it with their own agent, model and files. Nothing they do runs on your computer.

Either way, OMS asks you in the terminal before anyone gets in.

Sharing lasts until you close OMS or run `/remote stop`. People you already let in come back without asking once you run `/share` again; until then they are kept out. `/share stop` removes them for good.

### Who is live

While you both have the session open, each side sees the other in the status row: the host sees `shared · 1`, and the teammate sees the host's name with a green dot, or `away`. There is no server in between: your teammate's OMS connects straight to yours, so they must be able to reach your computer (the same network, Tailscale, or `/remote tunnel`).

### Sync

Two copies drift apart as each side keeps working. `/sync` brings them together while both are live. You can also ask the agent to sync the session; it has a tool for it while the session is shared.

- The other person is asked first and can say no. Then nothing moves.
- Each side gets what the other said and what their agent replied since the last sync, as one note in the conversation. The agent reads that note on its next turn.
- Your own history is never rewritten, and a note is never sent back to the side it came from.
- Only the conversation is synced. Files move the way they always do, through git.

### What a teammate receives

The current conversation, with secrets masked the way the screen masks them: key-shaped strings, values of secret-looking names, and every value of an env file the agent read. The model's private thinking is passed on unchanged, because providers reject edited thinking, so do not share a session in which the agent reasoned about a secret in the open. Paths in the shared history are the host's; the copy starts with a note saying so.

With Claude Code selected as the model, a sync note is shown but does not reach Claude's own chat history.
