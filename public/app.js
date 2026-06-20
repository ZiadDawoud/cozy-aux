const $ = (selector) => document.querySelector(selector);

function getTabParticipantId() {
  if (!window.name.startsWith("cozyAux:")) {
    window.name = `cozyAux:${crypto.randomUUID()}`;
  }
  return window.name.slice("cozyAux:".length);
}

function resetTabParticipantId() {
  window.name = `cozyAux:${crypto.randomUUID()}`;
  return window.name.slice("cozyAux:".length);
}

const els = {
  setupView: $("#setupView"),
  roomView: $("#roomView"),
  profileForm: $("#profileForm"),
  profileName: $("#profileName"),
  profileHandle: $("#profileHandle"),
  profileStatus: $("#profileStatus"),
  profileCard: $("#profileCard"),
  profileDisplayName: $("#profileDisplayName"),
  profileHandleText: $("#profileHandleText"),
  copyFriendCodeButton: $("#copyFriendCodeButton"),
  friendForm: $("#friendForm"),
  friendLookup: $("#friendLookup"),
  friendCount: $("#friendCount"),
  friendsList: $("#friendsList"),
  inviteList: $("#inviteList"),
  createForm: $("#createForm"),
  joinForm: $("#joinForm"),
  createName: $("#createName"),
  joinName: $("#joinName"),
  joinCode: $("#joinCode"),
  connectionStatus: $("#connectionStatus"),
  roomCode: $("#roomCode"),
  homeButton: $("#homeButton"),
  copyCodeButton: $("#copyCodeButton"),
  copyInviteButton: $("#copyInviteButton"),
  endRoomButton: $("#endRoomButton"),
  participants: $("#participants"),
  friendInviteForm: $("#friendInviteForm"),
  friendInviteSelect: $("#friendInviteSelect"),
  auxLabel: $("#auxLabel"),
  syncStatus: $("#syncStatus"),
  mediaTitle: $("#mediaTitle"),
  mediaMeta: $("#mediaMeta"),
  artwork: $("#artwork"),
  audioArtwork: $("#audioArtwork"),
  playerShell: $("#playerShell"),
  hostedPlayer: $("#hostedPlayer"),
  playerMount: $("#playerMount"),
  fullscreenButton: $("#fullscreenButton"),
  seekSlider: $("#seekSlider"),
  elapsed: $("#elapsed"),
  duration: $("#duration"),
  playButton: $("#playButton"),
  pauseButton: $("#pauseButton"),
  searchForm: $("#searchForm"),
  searchInput: $("#searchInput"),
  searchResults: $("#searchResults"),
  mediaForm: $("#mediaForm"),
  mediaInput: $("#mediaInput"),
  uploadForm: $("#uploadForm"),
  uploadInput: $("#uploadInput"),
  videoModeButton: $("#videoModeButton"),
  audioModeButton: $("#audioModeButton"),
  chatCount: $("#chatCount"),
  chatMessages: $("#chatMessages"),
  chatForm: $("#chatForm"),
  chatInput: $("#chatInput"),
  message: $("#message")
};

const state = {
  participantId: getTabParticipantId(),
  name: localStorage.getItem("cozyAuxName") || "",
  room: null,
  account: null,
  friends: [],
  invites: [],
  savedRooms: [],
  storageConfig: null,
  events: null,
  player: null,
  playerReady: false,
  appliedMediaId: null,
  suppressPlayerEventsUntil: 0,
  displayMode: localStorage.getItem("cozyAuxDisplayMode") || "video",
  isSeeking: false,
  lastSeekCommitAt: 0,
  lastRenderedMessageId: "",
  searchResults: [],
  searchLoading: false,
  pendingRoomCode: ""
};

function setMessage(message) {
  els.message.textContent = message || "";
}

function formatSec(seconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const secs = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${secs}`;
}

function currentPosition(playback) {
  if (!playback?.media) return 0;
  if (!playback.isPlaying || !playback.startedAt) return playback.positionSec || 0;
  return Math.max(0, (Date.now() - playback.startedAt) / 1000);
}

function isAuxHolder() {
  return state.room?.auxHolderId === state.participantId;
}

function activeMedia() {
  return state.room?.playback?.media || null;
}

function isHostedMedia(media = activeMedia()) {
  return media?.provider === "supabase";
}

function isYouTubeMedia(media = activeMedia()) {
  return !media || media.provider === "youtube";
}

function activeDuration() {
  const media = activeMedia();
  if (!media) return 0;
  if (isHostedMedia(media)) {
    return Number.isFinite(els.hostedPlayer.duration) ? els.hostedPlayer.duration : 0;
  }
  return state.playerReady ? state.player.getDuration?.() || 0 : 0;
}

function activeCurrentTime() {
  const media = activeMedia();
  if (!media) return 0;
  if (isHostedMedia(media)) return els.hostedPlayer.currentTime || 0;
  return state.playerReady ? state.player.getCurrentTime?.() || 0 : 0;
}

function isPlayerFullscreen() {
  return document.fullscreenElement === els.playerShell;
}

async function toggleFullscreen() {
  if (!document.fullscreenEnabled) {
    setMessage("Fullscreen is not available in this browser.");
    return;
  }
  if (isPlayerFullscreen()) {
    await document.exitFullscreen();
    return;
  }
  await els.playerShell.requestFullscreen();
}

function renderFullscreenButton() {
  const isFullscreen = isPlayerFullscreen();
  els.fullscreenButton.textContent = isFullscreen ? "Exit fullscreen" : "Fullscreen";
  els.fullscreenButton.setAttribute(
    "aria-label",
    isFullscreen ? "Exit fullscreen" : "Enter fullscreen"
  );
  els.fullscreenButton.disabled = !state.room?.playback?.media;
}

async function api(path, options = {}) {
  const authToken = localStorage.getItem("cozyAuxAuthToken");
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(authToken ? { "x-auth-token": authToken } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function extractYouTubeVideoId(value) {
  const input = value.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
    if (host.endsWith("youtube.com") || host.endsWith("music.youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v") || "";
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
      if (url.pathname.startsWith("/embed/")) return url.pathname.split("/")[2] || "";
    }
  } catch {
    return "";
  }

  return "";
}

function normalizeMedia(value) {
  const videoId = extractYouTubeVideoId(value);
  if (!videoId) return null;
  return {
    provider: "youtube",
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: "YouTube link",
    sourceLabel: value.includes("music.youtube.com") ? "YouTube Music" : "YouTube",
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  };
}

async function enrichMedia(media) {
  const data = await api(`/api/youtube/meta?videoId=${encodeURIComponent(media.videoId)}`).catch(
    () => ({ meta: null })
  );
  if (!data.meta) return media;
  return {
    ...media,
    title: data.meta.title || media.title,
    authorName: data.meta.authorName || "",
    thumbnailUrl: data.meta.thumbnailUrl || media.thumbnailUrl
  };
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.append(script);
  });
}

async function ensurePlayer() {
  await loadYouTubeApi();
  if (state.player) return state.player;
  state.player = new YT.Player("playerMount", {
    height: "100%",
    width: "100%",
    playerVars: {
      playsinline: 1,
      controls: 0,
      disablekb: 1,
      fs: 0,
      rel: 0,
      modestbranding: 1,
      origin: location.origin
    },
    events: {
      onReady: () => {
        state.playerReady = true;
        if (state.room?.playback?.media) {
          applyPlayback(null, state.room.playback);
        }
        render();
      },
      onStateChange: handlePlayerStateChange
    }
  });
  return state.player;
}

function handlePlayerStateChange(event) {
  if (
    Date.now() < state.suppressPlayerEventsUntil ||
    !state.room?.playback?.media ||
    !isYouTubeMedia(state.room.playback.media)
  ) {
    return;
  }
  const playerState = window.YT?.PlayerState;
  if (!playerState) return;

  if (event.data === playerState.PLAYING) {
    command("play", { positionSec: state.player.getCurrentTime() });
  } else if (event.data === playerState.PAUSED) {
    command("pause", { positionSec: state.player.getCurrentTime() });
  }
}

async function createRoom(event) {
  event.preventDefault();
  if (!state.account) {
    setMessage("Create a profile first so your rooms and friends can be saved.");
    els.profileName.focus();
    return;
  }
  state.name = els.createName.value.trim() || "Host";
  localStorage.setItem("cozyAuxName", state.name);
  const data = await api("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name: state.name, participantId: state.participantId })
  });
  enterRoom(data.room);
}

async function joinRoom(event) {
  event.preventDefault();
  if (!state.account) {
    setMessage("Create a profile first so your rooms and friends can be saved.");
    els.profileName.focus();
    return;
  }
  state.name = els.joinName.value.trim() || "Listener";
  localStorage.setItem("cozyAuxName", state.name);
  const code = els.joinCode.value.trim().toUpperCase();
  const data = await api(`/api/rooms/${code}/join`, {
    method: "POST",
    body: JSON.stringify({ name: state.name, participantId: state.participantId })
  });
  enterRoom(data.room);
}

function enterRoom(room) {
  state.room = {
    ...room,
    participants: room.participants.map((person) =>
      person.id === state.participantId ? { ...person, online: true } : person
    )
  };
  history.replaceState(
    null,
    "",
    `/?room=${room.code}&participant=${encodeURIComponent(state.participantId)}`
  );
  els.setupView.classList.add("hidden");
  els.roomView.classList.remove("hidden");
  if (room.playback?.media?.provider !== "supabase") ensurePlayer();
  openEvents();
  render();
  applyPlayback(null, state.room.playback);
}

function goHome() {
  if (state.events) {
    state.events.close();
    state.events = null;
  }
  state.room = null;
  state.appliedMediaId = null;
  els.roomView.classList.add("hidden");
  els.setupView.classList.remove("hidden");
  els.connectionStatus.textContent = "Offline";
  els.joinCode.value = "";
  setMessage("");
  history.replaceState(null, "", "/");
}

function openEvents() {
  if (state.events) state.events.close();
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.events = new WebSocket(
    `${protocol}://${location.host}/ws/rooms/${state.room.code}?participantId=${state.participantId}`
  );
  state.events.addEventListener("open", () => {
    els.connectionStatus.textContent = "Live";
  });
  state.events.addEventListener("close", () => {
    els.connectionStatus.textContent = "Reconnecting";
    if (state.room) setTimeout(openEvents, 700);
  });
  state.events.addEventListener("error", () => {
    els.connectionStatus.textContent = "Reconnecting";
  });
  state.events.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);
    const eventName = message.event;
    const nextRoom = message.data;
    if (eventName === "room-ended" || nextRoom?.endedAt) {
      setMessage("This room was ended.");
      goHome();
      await loadAccount().catch(() => {});
      return;
    }
    const previousPlayback = state.room?.playback;
    const canAffectPlayback = !["aux-transfer", "presence", "chat-send", "room"].includes(eventName);
    const playbackChanged =
      canAffectPlayback &&
      (previousPlayback?.updatedAt !== nextRoom.playback?.updatedAt ||
        previousPlayback?.media?.provider !== nextRoom.playback?.media?.provider ||
        previousPlayback?.media?.videoId !== nextRoom.playback?.media?.videoId ||
        previousPlayback?.media?.path !== nextRoom.playback?.media?.path ||
        previousPlayback?.isPlaying !== nextRoom.playback?.isPlaying);
    state.room = nextRoom;
    render();
    if (playbackChanged) {
      await applyPlayback(previousPlayback, nextRoom.playback);
    }
  });
}

async function command(type, payload = {}) {
  if (!state.room) return;
  try {
    return await api(`/api/rooms/${state.room.code}/commands`, {
      method: "POST",
      body: JSON.stringify({
        type,
        participantId: state.participantId,
        ...payload
      })
    });
  } catch (error) {
    setMessage(error.message);
    return null;
  }
}

async function loadAccount() {
  const data = await api("/api/me");
  state.account = data.user;
  state.friends = data.friends || [];
  state.invites = data.invites || [];
  state.savedRooms = data.rooms || [];
  if (state.account) {
    state.name = state.account.displayName;
    localStorage.setItem("cozyAuxName", state.name);
    els.createName.value = state.name;
    els.joinName.value = state.name;
  }
  renderAccount();
}

async function loadStorageConfig() {
  const data = await api("/api/storage/config").catch(() => ({ configured: false }));
  state.storageConfig = data.configured ? data.storage : null;
}

function uploadExtension(file) {
  const nameExtension = file.name.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
  if (nameExtension) return nameExtension;
  if (file.type === "audio/mpeg") return ".mp3";
  if (file.type === "audio/mp4") return ".m4a";
  if (file.type === "video/mp4") return ".mp4";
  if (file.type === "video/webm") return ".webm";
  return "";
}

function hostedMediaType(file) {
  return file.type.startsWith("video/") ? "video" : "audio";
}

async function uploadToSupabase(file) {
  const config = state.storageConfig;
  if (!config) throw new Error("Add Supabase storage environment variables before uploading.");
  if (file.size > config.maxUploadBytes) {
    throw new Error(`File is too large. Limit is ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB.`);
  }
  const extension = uploadExtension(file);
  if (![".mp3", ".m4a", ".wav", ".ogg", ".mp4", ".webm"].includes(extension)) {
    throw new Error("Choose an MP3, M4A, WAV, OGG, MP4, or WebM file.");
  }

  const objectPath = `${state.room.code}/${crypto.randomUUID()}${extension}`;
  const baseUrl = config.supabaseUrl.replace(/\/$/, "");
  const uploadUrl = `${baseUrl}/storage/v1/object/${encodeURIComponent(config.bucket)}/${objectPath}`;
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: config.anonKey,
      authorization: `Bearer ${config.anonKey}`,
      "content-type": file.type || "application/octet-stream",
      "x-upsert": "false"
    },
    body: file
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || body.message || "Supabase upload failed.");
  }

  return {
    provider: "supabase",
    mediaType: hostedMediaType(file),
    path: objectPath,
    url: `${baseUrl}/storage/v1/object/public/${encodeURIComponent(config.bucket)}/${objectPath}`,
    title: file.name.replace(/\.[^.]+$/, "") || "Uploaded media",
    sourceLabel: hostedMediaType(file) === "video" ? "Uploaded video" : "Uploaded audio",
    fileName: file.name,
    sizeBytes: file.size,
    mimeType: file.type || "application/octet-stream",
    thumbnailUrl: ""
  };
}

function renderAccount() {
  const user = state.account;
  els.profileStatus.textContent = user ? "Saved" : "Not set";
  els.profileForm.classList.toggle("hidden", Boolean(user));
  els.profileCard.classList.toggle("hidden", !user);
  if (user) {
    els.profileDisplayName.textContent = user.displayName;
    els.profileHandleText.textContent = `@${user.handle} · friend code ${user.friendCode}`;
  }

  els.friendCount.textContent = String(state.friends.length);
  els.friendsList.innerHTML = "";
  if (!user) {
    els.friendsList.innerHTML = `<div class="list-row empty">Create a profile to add friends.</div>`;
  } else if (!state.friends.length) {
    els.friendsList.innerHTML = `<div class="list-row empty">No friends yet.</div>`;
  } else {
    for (const friend of state.friends) {
      const row = document.createElement("div");
      row.className = "list-row";
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(friend.displayName)}</strong>
          <span class="muted small">@${escapeHtml(friend.handle)}</span>
        </div>
      `;
      els.friendsList.append(row);
    }
  }

  els.inviteList.innerHTML = "";
  for (const invite of state.invites) {
    const row = document.createElement("div");
    row.className = "list-row";
    row.innerHTML = `
      <div>
        <strong>Room ${escapeHtml(invite.roomCode)}</strong>
        <span class="muted small">Invited by ${escapeHtml(invite.from?.displayName || "a friend")}</span>
      </div>
      <button class="secondary" type="button">Join</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      els.joinCode.value = invite.roomCode;
      els.joinName.value = state.name || user.displayName;
      els.joinForm.requestSubmit();
    });
    els.inviteList.append(row);
  }
}

async function createProfile(event) {
  event.preventDefault();
  const displayName = els.profileName.value.trim();
  const handle = els.profileHandle.value.trim();
  try {
    const data = await api("/api/users", {
      method: "POST",
      body: JSON.stringify({ displayName, handle })
    });
    localStorage.setItem("cozyAuxAuthToken", data.authToken);
    state.account = data.user;
    state.name = data.user.displayName;
    localStorage.setItem("cozyAuxName", state.name);
    els.createName.value = state.name;
    els.joinName.value = state.name;
    await loadAccount();
    setMessage("Profile created.");
  } catch (error) {
    setMessage(error.message);
  }
}

async function addFriend(event) {
  event.preventDefault();
  const lookup = els.friendLookup.value.trim();
  if (!lookup) return;
  try {
    const data = await api("/api/friends", {
      method: "POST",
      body: JSON.stringify({ lookup })
    });
    state.friends = data.friends || [];
    els.friendLookup.value = "";
    renderAccount();
    render();
    setMessage("Friend added.");
  } catch (error) {
    setMessage(error.message);
  }
}

async function applyPlayback(previous, playback) {
  if (!playback?.media) return;
  const nextPosition = currentPosition(playback);
  const previousKey = previous?.media?.provider === "supabase" ? previous.media.path : previous?.media?.videoId;
  const nextKey = playback.media.provider === "supabase" ? playback.media.path : playback.media.videoId;
  const mediaChanged = previous?.media?.provider !== playback.media.provider || previousKey !== nextKey;

  state.suppressPlayerEventsUntil = Date.now() + 1200;
  if (isHostedMedia(playback.media)) {
    const player = els.hostedPlayer;
    if (state.playerReady) {
      state.suppressPlayerEventsUntil = Date.now() + 1200;
      state.player.pauseVideo();
    }
    if (mediaChanged || state.appliedMediaId !== nextKey) {
      state.appliedMediaId = nextKey;
      player.src = playback.media.url;
      player.load();
    }
    if (Math.abs((player.currentTime || 0) - nextPosition) > 0.6) {
      player.currentTime = nextPosition;
    }
    if (playback.isPlaying) {
      player.play().catch(() => setMessage("Press Play if your browser blocked autoplay."));
    } else {
      player.pause();
    }
    return;
  }

  els.hostedPlayer.pause();
  const player = await ensurePlayer();
  if (!state.playerReady) return;
  if (mediaChanged || state.appliedMediaId !== nextKey) {
    state.appliedMediaId = nextKey;
    player.loadVideoById(playback.media.videoId, nextPosition);
  } else {
    const actual = player.getCurrentTime?.() || 0;
    if (Math.abs(actual - nextPosition) > 1.2) {
      player.seekTo(nextPosition, true);
    }
  }

  if (playback.isPlaying) {
    player.playVideo();
  } else {
    player.pauseVideo();
  }
}

async function submitMedia(event) {
  event.preventDefault();
  if (!isAuxHolder()) {
    setMessage("Only the aux holder can change the link.");
    return;
  }
  const media = normalizeMedia(els.mediaInput.value);
  if (!media) {
    setMessage("Paste a valid YouTube or YouTube Music link.");
    return;
  }
  setMessage("Loading link...");
  await command("media-change", { media: await enrichMedia(media) });
  setMessage("");
}

async function submitUpload(event) {
  event.preventDefault();
  if (!isAuxHolder()) {
    setMessage("Only the aux holder can upload media.");
    return;
  }
  const file = els.uploadInput.files?.[0];
  if (!file) {
    setMessage("Choose an MP3, MP4, M4A, WAV, OGG, or WebM file.");
    return;
  }
  try {
    setMessage("Uploading to Supabase...");
    const media = await uploadToSupabase(file);
    const data = await command("media-change", { media });
    if (data?.room) {
      state.room = data.room;
      els.uploadInput.value = "";
      render();
      await applyPlayback(null, state.room.playback);
    }
    setMessage("");
  } catch (error) {
    setMessage(error.message);
  }
}

async function searchYouTube(event) {
  event.preventDefault();
  const query = els.searchInput.value.trim();
  if (!query) return;
  state.searchLoading = true;
  state.searchResults = [];
  renderSearchResults();
  try {
    const data = await api(`/api/youtube/search?q=${encodeURIComponent(query)}`);
    state.searchResults = data.results || [];
    if (!state.searchResults.length) setMessage("No YouTube results found.");
    else setMessage("");
  } catch (error) {
    setMessage(error.message);
  } finally {
    state.searchLoading = false;
    renderSearchResults();
  }
}

async function loadSearchResult(media) {
  if (!isAuxHolder()) {
    setMessage("Only the aux holder can load search results.");
    return;
  }
  setMessage("Loading result...");
  const data = await command("media-change", { media });
  if (data?.room) {
    state.room = data.room;
    render();
  }
  setMessage("");
}

function renderSearchResults() {
  els.searchResults.innerHTML = "";
  if (state.searchLoading) {
    const row = document.createElement("div");
    row.className = "search-empty";
    row.textContent = "Searching...";
    els.searchResults.append(row);
    return;
  }
  for (const result of state.searchResults) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "search-result";
    row.disabled = !isAuxHolder();
    row.innerHTML = `
      <span class="search-thumb" style="background-image: url('${escapeHtml(result.thumbnailUrl)}')"></span>
      <span class="search-copy">
        <strong>${escapeHtml(result.title)}</strong>
        <span class="muted small">${escapeHtml(result.authorName || "YouTube")}</span>
      </span>
    `;
    row.addEventListener("click", () => loadSearchResult(result));
    els.searchResults.append(row);
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
  });
}

function renderMessages(messages = []) {
  const lastMessage = messages.at(-1);
  if (state.lastRenderedMessageId === (lastMessage?.id || "") && els.chatMessages.childElementCount === messages.length) {
    return;
  }
  state.lastRenderedMessageId = lastMessage?.id || "";
  els.chatCount.textContent = String(messages.length);
  els.chatMessages.innerHTML = "";
  for (const message of messages) {
    const row = document.createElement("div");
    row.className = `chat-message${message.participantId === state.participantId ? " own" : ""}${
      message.system ? " system" : ""
    }`;
    const time = new Date(message.sentAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });
    row.innerHTML = `
      <div class="chat-meta">
        <strong>${escapeHtml(message.name)}</strong>
        <span>${escapeHtml(time)}</span>
      </div>
      <p>${escapeHtml(message.text)}</p>
    `;
    els.chatMessages.append(row);
  }
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function addLocalSystemMessage(text) {
  if (!state.room) return;
  state.room = {
    ...state.room,
    messages: [
      ...(state.room.messages || []),
      {
        id: `local-${Date.now()}`,
        participantId: "system",
        name: "Cozy Aux",
        text,
        sentAt: Date.now(),
        system: true
      }
    ].slice(-100)
  };
}

function render() {
  const room = state.room;
  if (!room) {
    renderAccount();
    return;
  }
  els.roomCode.textContent = room.code;
  const isOwner = state.account?.id && room.ownerUserId === state.account.id;
  els.endRoomButton.disabled = !isOwner;
  els.endRoomButton.classList.toggle("hidden", !isOwner);

  const aux = room.participants.find((person) => person.id === room.auxHolderId);
  els.auxLabel.textContent = `Aux: ${aux?.name || "--"}`;

  const playback = room.playback;
  const media = playback.media;
  const hostedMedia = isHostedMedia(media);
  els.mediaTitle.textContent = media ? media.title : "No link selected";
  els.mediaMeta.textContent = media
    ? [media.sourceLabel, media.authorName, media.videoId || media.fileName].filter(Boolean).join(" · ")
    : "Paste a YouTube link or upload a media file to start.";
  els.artwork.style.backgroundImage = media?.thumbnailUrl ? `url("${media.thumbnailUrl}")` : "";
  els.audioArtwork.style.backgroundImage = media?.thumbnailUrl
    ? `url("${media.thumbnailUrl}")`
    : "";
  els.hostedPlayer.classList.toggle("hidden", !hostedMedia);
  els.playerMount.classList.toggle("hidden", hostedMedia);
  els.hostedPlayer.controls = false;
  if (hostedMedia && els.hostedPlayer.src !== media.url) {
    els.hostedPlayer.src = media.url;
  }

  const position = currentPosition(playback);
  const playerDuration = activeDuration();
  const actual = activeCurrentTime();
  const drift = media ? Math.abs(actual - position) : 0;
  els.syncStatus.textContent = media ? (drift > 2.5 ? "Catching up" : "In sync") : "No media";
  els.seekSlider.max = String(playerDuration || 100);
  if (!state.isSeeking) {
    els.seekSlider.value = String(Math.min(position, playerDuration || 100));
  }
  els.elapsed.textContent = formatSec(position);
  els.duration.textContent = playerDuration ? formatSec(playerDuration) : "--:--";
  els.seekSlider.disabled = !isAuxHolder() || !media;
  renderFullscreenButton();
  els.searchInput.disabled = !isAuxHolder();
  els.searchForm.querySelector("button").disabled = !isAuxHolder() || state.searchLoading;
  els.mediaInput.disabled = !isAuxHolder();
  els.mediaForm.querySelector("button").disabled = !isAuxHolder();
  els.uploadInput.disabled = !isAuxHolder() || !state.storageConfig;
  els.uploadForm.querySelector("button").disabled = !isAuxHolder() || !state.storageConfig;
  els.searchInput.placeholder = isAuxHolder() ? "Search YouTube" : "Only the aux holder can search";
  els.mediaInput.placeholder = isAuxHolder()
    ? "Paste YouTube or YouTube Music link"
    : "Only the aux holder can load links";
  document.body.classList.toggle("audio-focus", state.displayMode === "audio");
  els.videoModeButton.classList.toggle("secondary", state.displayMode !== "video");
  els.audioModeButton.classList.toggle("secondary", state.displayMode !== "audio");
  renderSearchResults();
  renderMessages(room.messages || []);

  els.friendInviteSelect.innerHTML = "";
  const availableFriends = state.friends.filter(
    (friend) => !room.participants.some((person) => person.userId === friend.id)
  );
  if (!availableFriends.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No friends to invite";
    els.friendInviteSelect.append(option);
  } else {
    for (const friend of availableFriends) {
      const option = document.createElement("option");
      option.value = friend.id;
      option.textContent = friend.displayName;
      els.friendInviteSelect.append(option);
    }
  }
  els.friendInviteForm.classList.toggle("hidden", !isOwner);
  els.friendInviteSelect.disabled = !isOwner || !availableFriends.length;
  els.friendInviteForm.querySelector("button").disabled = !isOwner || !availableFriends.length;

  els.participants.innerHTML = "";
  const otherParticipants = room.participants.filter((person) => person.id !== state.participantId);
  for (const person of room.participants) {
    const row = document.createElement("div");
    row.className = `person${person.online ? " online" : ""}`;
    const badges = [
      person.id === state.participantId ? "you" : "",
      person.id === room.auxHolderId ? "aux" : ""
    ]
      .filter(Boolean)
      .join(" · ");
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(person.name)}</strong>
        <span class="muted small">${[person.online ? "online" : "offline", badges].filter(Boolean).join(" · ")}</span>
      </div>
    `;
    if (person.id !== state.participantId) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = "Pass aux";
      button.disabled = !isAuxHolder();
      let transferInFlight = false;
      const passAux = async () => {
        if (!isAuxHolder() || transferInFlight) return;
        transferInFlight = true;
        const previousRoom = state.room;
        const from = state.room.participants.find((participant) => participant.id === state.participantId);
        state.room = {
          ...state.room,
          auxHolderId: person.id
        };
        addLocalSystemMessage(`${from?.name || "Someone"} passed aux to ${person.name}.`);
        render();
        button.disabled = true;
        const data = await command("aux-transfer", { toParticipantId: person.id });
        if (data?.room) {
          state.room = data.room;
          render();
        } else {
          state.room = previousRoom;
          render();
          setMessage("Aux transfer failed. Try again after both people are connected.");
        }
        transferInFlight = false;
        button.disabled = false;
      };
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        passAux();
      });
      button.addEventListener("click", passAux);
      row.append(button);
    }
    els.participants.append(row);
  }
  if (!otherParticipants.length) {
    const row = document.createElement("div");
    row.className = "person empty";
    row.innerHTML = `
      <div>
        <strong>No one else yet</strong>
        <span class="muted small">Share the invite link to pass aux.</span>
      </div>
    `;
    els.participants.append(row);
  }
}

function renderPlaybackProgress() {
  if (!state.room) return;
  const playback = state.room.playback;
  const media = playback.media;
  const position = currentPosition(playback);
  const playerDuration = activeDuration();
  const actual = activeCurrentTime();
  const drift = media ? Math.abs(actual - position) : 0;

  els.syncStatus.textContent = media ? (drift > 2.5 ? "Catching up" : "In sync") : "No media";
  els.seekSlider.max = String(playerDuration || 100);
  if (!state.isSeeking) {
    els.seekSlider.value = String(Math.min(position, playerDuration || 100));
  }
  els.elapsed.textContent = formatSec(position);
  els.duration.textContent = playerDuration ? formatSec(playerDuration) : "--:--";
}

function tick() {
  if (state.room) {
    renderPlaybackProgress();
    const playback = state.room.playback;
    if (!state.isSeeking && playback?.media && playback.isPlaying) {
      const desired = currentPosition(playback);
      const actual = activeCurrentTime();
      if (Math.abs(actual - desired) > 2.5) {
        state.suppressPlayerEventsUntil = Date.now() + 1000;
        if (isHostedMedia(playback.media)) {
          els.hostedPlayer.currentTime = desired;
        } else if (state.playerReady) {
          state.player.seekTo(desired, true);
        }
      }
    }
  }
  requestAnimationFrame(tick);
}

async function restoreRoomFromUrl(params) {
  const code = params.get("room")?.toUpperCase();
  if (!code) return;
  const forceJoin = params.get("join") === "1";
  const participantFromUrl = params.get("participant");
  if (forceJoin) {
    state.participantId = resetTabParticipantId();
    els.joinName.value = "";
  } else if (participantFromUrl) {
    state.participantId = participantFromUrl;
    window.name = `cozyAux:${participantFromUrl}`;
  }
  state.pendingRoomCode = code;
  els.joinCode.value = code;
  try {
    const data = await api(`/api/rooms/${code}`);
    const isInRoom = data.room.participants.some((person) => person.id === state.participantId);
    if (isInRoom && !forceJoin) enterRoom(data.room);
    else {
      els.joinCode.value = code;
      els.setupView.classList.remove("hidden");
      els.roomView.classList.add("hidden");
      setMessage(`Enter your name to join room ${code}.`);
      els.joinName.focus();
    }
  } catch {
    setMessage("That room is not active anymore.");
  }
}

async function init() {
  await loadStorageConfig();
  await loadAccount();
  const params = new URLSearchParams(location.search);
  await restoreRoomFromUrl(params);
}

els.createName.value = state.name;
els.joinName.value = state.name;
els.profileName.value = state.name;
els.profileHandle.value = state.name.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
els.profileForm.addEventListener("submit", createProfile);
els.friendForm.addEventListener("submit", addFriend);
els.copyFriendCodeButton.addEventListener("click", async () => {
  if (!state.account) return;
  await navigator.clipboard.writeText(state.account.friendCode);
  setMessage("Friend code copied.");
});
els.createForm.addEventListener("submit", createRoom);
els.joinForm.addEventListener("submit", joinRoom);
els.homeButton.addEventListener("click", goHome);
els.fullscreenButton.addEventListener("click", () => {
  toggleFullscreen().catch(() => setMessage("Fullscreen could not be started."));
});
document.addEventListener("fullscreenchange", renderFullscreenButton);
els.endRoomButton.addEventListener("click", async () => {
  if (!state.room) return;
  const confirmEnd = window.confirm("End this room for everyone?");
  if (!confirmEnd) return;
  try {
    await api(`/api/rooms/${state.room.code}/end`, { method: "POST", body: "{}" });
    goHome();
    await loadAccount();
    setMessage("Room ended.");
  } catch (error) {
    setMessage(error.message);
  }
});
els.friendInviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.room || !els.friendInviteSelect.value) return;
  try {
    await api(`/api/rooms/${state.room.code}/invites`, {
      method: "POST",
      body: JSON.stringify({ friendId: els.friendInviteSelect.value })
    });
    setMessage("Friend invited.");
  } catch (error) {
    setMessage(error.message);
  }
});
els.copyInviteButton.addEventListener("click", async () => {
  const url = `${location.origin}/?room=${state.room.code}&join=1`;
  await navigator.clipboard.writeText(url);
  setMessage("Invite link copied.");
});
els.copyCodeButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.room.code);
  setMessage("Room code copied.");
});
els.playButton.addEventListener("click", () =>
  command("play", {
    positionSec: activeMedia() ? activeCurrentTime() : currentPosition(state.room?.playback)
  })
);
els.pauseButton.addEventListener("click", () =>
  command("pause", {
    positionSec: activeMedia() ? activeCurrentTime() : currentPosition(state.room?.playback)
  })
);
function commitSeek() {
  const now = Date.now();
  if (now - state.lastSeekCommitAt < 150) return;
  state.lastSeekCommitAt = now;
  state.isSeeking = false;
  command("seek", { positionSec: Number(els.seekSlider.value) });
}

els.seekSlider.addEventListener("change", () => {
  if (!state.isSeeking) commitSeek();
});
els.seekSlider.addEventListener("pointerdown", () => {
  state.isSeeking = true;
});
els.seekSlider.addEventListener("input", () => {
  if (state.isSeeking) els.elapsed.textContent = formatSec(Number(els.seekSlider.value));
});
els.seekSlider.addEventListener("pointerup", commitSeek);
els.seekSlider.addEventListener("touchend", commitSeek);
els.searchForm.addEventListener("submit", searchYouTube);
els.mediaForm.addEventListener("submit", submitMedia);
els.uploadForm.addEventListener("submit", submitUpload);
els.hostedPlayer.addEventListener("loadedmetadata", renderPlaybackProgress);
els.hostedPlayer.addEventListener("play", () => {
  if (Date.now() < state.suppressPlayerEventsUntil || !isHostedMedia()) return;
  command("play", { positionSec: activeCurrentTime() });
});
els.hostedPlayer.addEventListener("pause", () => {
  if (Date.now() < state.suppressPlayerEventsUntil || !isHostedMedia()) return;
  command("pause", { positionSec: activeCurrentTime() });
});
els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.chatInput.value = "";
  await command("chat-send", { text });
});
els.videoModeButton.addEventListener("click", () => {
  state.displayMode = "video";
  localStorage.setItem("cozyAuxDisplayMode", state.displayMode);
  render();
});
els.audioModeButton.addEventListener("click", () => {
  state.displayMode = "audio";
  localStorage.setItem("cozyAuxDisplayMode", state.displayMode);
  render();
});

init().catch((error) => setMessage(error.message));
tick();
