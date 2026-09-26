# secrets/ — consume-once drop box (normally EMPTY)

Nothing here is ever shipped, committed or kept.

Only if you cannot use the interactive prompt (for example, launching from the Container Manager
UI instead of SSH), put the Cloudflare API token in a file named exactly:

    secrets/cloudflare_api_token

The deployer reads it at start-up, overwrites it with zeros and deletes it before doing anything
else. Create it again right before each run that needs Cloudflare access.

**Caveat (Synology btrfs):** the volume is copy-on-write and often snapshotted, so overwriting does
NOT destroy the old blocks, and a snapshot taken while the file existed keeps it. Prefer the hidden
prompt (`sudo ./kawa-edge install` over SSH); if you use this file, do it on a shared folder without
snapshots, and roll the token when the installation is finished.

Hub webhook URLs are never accepted from a file: they are typed at a hidden prompt.
