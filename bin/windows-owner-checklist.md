# Windows-side owner checklist + host budget

**EXAMPLE (machine-specific).** The paths below are the authoring machine's own Windows host layout, written portably with `%USERPROFILE%`; substitute your own account/paths.

Status legend: `[ ] pending — user must run on Windows` means the agent did **not** and **cannot** run this. Nothing on this page is claimed as executed. opencode runs inside WSL; these steps touch the Windows host, so they belong to you, the human owner.

## Host budget reality

Read this before the checklist, because it explains why the steps matter.

- The host machine has roughly **6GB of physical RAM total**. That is the ceiling for everything: Windows, WSL, and any service either one runs.
- WSL is capped at **4GB** (the `memory=4GB` line). Windows keeps the rest. If WSL is allowed to grow to the full 6GB, Windows has no headroom for its own processes and can stall or kill the VM.
- Inside that same 4GB, other VM services **compete with opencode**: PostgreSQL, the Vite dev server, and Docker all draw from the 4GB pool. When they run during coding, opencode gets less, and the OOM pressure that GAP-1 describes gets worse.
- **Stop PostgreSQL, Vite, and Docker while coding in opencode.** Start them only when a task actually needs them.

## Current `.wslconfig` (as read by the agent, not modified)

Path: `%USERPROFILE%\.wslconfig`

```
[wsl2]
memory=4GB
swap=2GB

[experimental]
autoMemoryReclaim=gradual
sparseVhd=true
```

The problem: `swap=2GB` and no `pageReporting`. With a 4GB memory cap and only 2GB of swap, a memory spike that overflows RAM runs out of swap sooner, which raises the chance of an OOM kill (GAP-1) and can take down opencode instead of a single process (IS-1).

## Checklist

### 1. Edit `%USERPROFILE%\.wslconfig`

- [ ] **pending — user must run on Windows**

Open the file in Notepad (or any editor) and set the `[wsl2]` block to exactly this:

```
[wsl2]
memory=4GB
swap=8GB
pageReporting=true
```

Then save the file.

- **Why:** raises swap from 2GB to 8GB so a spike has room to page instead of triggering an OOM kill, and enables page reporting so WSL returns freed memory to Windows. This directly mitigates **GAP-1** (repeated OOM kills) and **IS-1** (opencode survives VM memory pressure).
- **Exact check (PowerShell, from Windows):**
  ```powershell
  Get-Content "$env:USERPROFILE\.wslconfig"
  ```
  Expect `memory=4GB`, `swap=8GB`, `pageReporting=true` under `[wsl2]`. You can keep the existing `[experimental]` lines (`autoMemoryReclaim=gradual`, `sparseVhd=true`); they don't conflict.

### 2. Shut down WSL so the new config takes effect

- [ ] **pending — user must run on Windows**

From **Windows PowerShell** (not inside WSL):

```powershell
wsl --shutdown
```

Then reopen your WSL terminal (or run `wsl` from PowerShell) to start WSL again with the new settings. A restart of the distro is required; the config is only read when the VM boots.

- **Why:** `.wslconfig` changes do not apply to a running VM. Without this restart the memory and swap limits stay at the old values, so step 1 has no effect. Keeping the restart explicit closes the gap between "file edited" and "limits active".
- **Exact check (PowerShell):**
  ```powershell
  wsl --shutdown
  ```
  The command returns with no output on success. Then confirm the VM is down and back up:
  ```powershell
  wsl -l -v
  ```
  State should move from `Running` to `Stopped`, then back to `Running` after you start a distro.

### 3. Verify swap is 8GB after restart

- [ ] **pending — user must run on Windows (and then inside WSL)**

After WSL restarts, run these **inside WSL**:

```bash
free -h
```

Expect `Swap:` total near `8.0Gi` (it can show slightly less than 8Gi). If it still shows `2.0Gi`, the restart in step 2 did not happen or the file was saved in the wrong place.

Supporting checks:

```bash
nproc
cat /proc/meminfo | head
```

- `nproc` shows the CPU count WSL sees. Note it for any later resource-limit decision; it does not change with `.wslconfig`.
- `cat /proc/meminfo | head` shows `MemTotal` (should stay ~4GiB, matching the 4GB cap) and `SwapTotal`. Confirm `SwapTotal` is ~8GiB.

- **Why:** this is the proof that steps 1 and 2 worked. Without the check, you are trusting an edit and a restart that may have silently failed, and GAP-1 remains open.
- **Exact checks (inside WSL):**
  ```bash
  free -h
  nproc
  cat /proc/meminfo | head
  ```

## Verification summary

| Item | Verifiable by | Expected |
|---|---|---|
| `.wslconfig` edited | `Get-Content %USERPROFILE%\.wslconfig` (PowerShell) | `memory=4GB`, `swap=8GB`, `pageReporting=true` under `[wsl2]` |
| WSL restarted | `wsl --shutdown` then `wsl -l -v` (PowerShell) | runs clean, distro state cycles to `Stopped` and back |
| Swap is 8GB | `free -h` (WSL) | `Swap:` total ~8.0Gi |
| Memory cap intact | `cat /proc/meminfo \| head` (WSL) | `MemTotal` ~4GiB |
| CPU count | `nproc` (WSL) | integer, unchanged by config |

Every row above is `[ ] pending — user must run on Windows`. The agent has read `%USERPROFILE%\.wslconfig` for reporting only; it did not edit it and did not run any Windows command.
