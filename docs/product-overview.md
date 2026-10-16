# Product overview

## Purpose

P2Sharer is a shared space for connecting, creating and exploring together through peer-to-peer connections. Its goal is to make the most of P2P by bringing an expanding range of shared experiences and tools into one Windows desktop app.

Rooms bring people and tools together: participants can communicate, share media and files, browse, watch, write, draw and connect local services. Screen and application audio sharing are part of that experience. The product's scope remains open to new uses of peer-to-peer connections rather than being defined by a single feature or a fixed list of apps.

Descriptions should explain that purpose and give concrete examples of what users can do now. Future plans must remain distinguishable from available capabilities. Voice calling is planned; it is not currently available.

## Reusable descriptions

**Short description**

A shared space to connect, create and explore through P2P.

**Full description**

Connect with people and explore what you can do together through P2P. P2Sharer brings chat, file transfers, a shared browser, whiteboards, collaborative notes, synchronized YouTube playback, screen and application audio sharing, cameras, and local networking tools into shared rooms. Personalize your profile, choose the apps and streams you want to join, and make room for collaboration, entertainment and new shared experiences.

## Current capability reference

This reference is based on the registered apps, frontend services and native implementation. Availability in source does not establish interactive validation on every device or network. The linked subsystem references document relevant limitations.

| Area | Available capabilities | Implementation and technical reference |
| --- | --- | --- |
| Rooms and participation | Create and join rooms through invitations, optional passwords, saved rooms, host/admin admission and ownership controls | [`room_service.ts`](../src/services/room_service.ts), [room authorization](../.agents/knowledge/peer-security.md) |
| Chat and files | Messages, images, editing/deletion and file transfers with recipient consent | [`group_room.ts`](../src/p2p/group_room.ts), [file transfers](../.agents/knowledge/chat-file-transfer.md) |
| Shared browser | A host-rendered browser with tabs, shared input and audio; persistent or temporary local browser sessions | [`BrowserApp.tsx`](../src/apps/BrowserApp.tsx), [`browser_model.ts`](../src/apps/browser_model.ts), [shared browser architecture](../.agents/knowledge/shared-browser.md) |
| Whiteboard | Collaborative drawing, shapes, text, layers, participant cursors, local saves and image/vector exports | [`WhiteboardApp.tsx`](../src/apps/WhiteboardApp.tsx), [`whiteboard_model.ts`](../src/apps/whiteboard_model.ts), [room apps](../.agents/knowledge/room-apps.md) |
| Notepad | Collaborative rich-text editing and selections, local document library, import and export | [`NotepadApp.tsx`](../src/apps/NotepadApp.tsx), [`models.ts`](../src/apps/models.ts), [room apps](../.agents/knowledge/room-apps.md) |
| YouTube | Shared video queues, synchronized playback, playlist imports, saved queues and player picture-in-picture | [`YouTubeApp.tsx`](../src/apps/YouTubeApp.tsx), [`models.ts`](../src/apps/models.ts), [room apps](../.agents/knowledge/room-apps.md) |
| Media sharing | Multiple screen/window/camera streams, application audio filtering, per-participant volume, grid/spotlight layouts, picture-in-picture and stream annotations | [`room_service.ts`](../src/services/room_service.ts), [multiple streams](../.agents/knowledge/multiple-media-streams.md), [native media](../.agents/knowledge/native-media-pipeline.md), [UI contracts](../.agents/knowledge/frontend-ui-state.md) |
| Local networking | Selected TCP/UDP service sharing through proxies and a virtual IPv4 network with scoped permissions | [`TunnelApp.tsx`](../src/apps/TunnelApp.tsx), [`tunnel_model.ts`](../src/apps/tunnel_model.ts), [port tunnels](../.agents/knowledge/port-tunnels.md), [virtual network](../.agents/knowledge/virtual-network.md) |
| Profiles and appearance | Names, avatars, profile banners, local usage statistics, themes, accent/background colors and language preferences | [`ProfileModal.tsx`](../src/components/modals/ProfileModal.tsx), [`SettingsModal.tsx`](../src/components/modals/SettingsModal.tsx), [profile images](../.agents/knowledge/profile-images.md), [localization](../.agents/knowledge/localization.md) |
| App participation | Multiple app instances, opt-in participation, personal apps and detached native windows for supported apps | [`registry.ts`](../src/apps/registry.ts), [`room_apps_service.ts`](../src/apps/room_apps_service.ts), [room apps](../.agents/knowledge/room-apps.md) |

## Connection and platform boundaries

- The current product targets Windows x64 through Tauri v2 and WebView2.
- Room media and collaborative state use peer-to-peer WebRTC connections. Internet rooms still use public discovery/signaling services. YouTube and external websites retain their own network and privacy dependencies.
- The experimental Local network / VPN room mode is separate from the virtual network app. See [LAN mesh](../.agents/knowledge/lan-mesh.md) for discovery and interoperability limits.
- The virtual network uses the third-party Wintun driver and a temporary helper requiring Windows administrator consent. It does not provide general Internet routing.
- Shared room-app state depends on connected peers. Notes and whiteboards can be saved locally; a room is not a hosted cloud workspace with guaranteed permanent storage.
- Quality, capacity and connectivity depend on participant hardware, network conditions and feature settings. The P2P architecture is not a claim of unlimited scale, complete anonymity or independence from every external service.

## Presentation entrypoints

The [README](../README.md) presents the product to repository visitors. The [knowledge index](../.agents/knowledge.md) and networking overview link this reference for maintainers. `home.description` supplies the compact home introduction, and `message.80801012506c` supplies the localized main-window caption in all 13 app catalogs. The HTML and Tauri window titles provide initial fallback captions; the Cargo description supplies native package metadata.
