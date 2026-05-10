const params = new URLSearchParams(window.location.search);
const courseId = params.get("courseId");
const userId = params.get("userId");

const protocol = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${protocol}://${location.host}`);

let state = {};
let connected = false;
let mySelectedAnswer = null;
let previouslyAlive = new Set();
let confettiRunning = false;
let celebrating = false;

// ===============================
// CONNECTION
// ===============================

ws.onopen = () => {
  connected = true;
  document.getElementById("status").textContent = "Connected";

  ws.send(JSON.stringify({
    type: "join",
    courseId,
    userId
  }));
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);

  console.log("STATE:", data);

  // ✅ ONLY ONE TYPE NOW
  if (data.type === "state") {
    state = data;
    render();

    // ✅ handle round animation (optional but supported)
    if (data.roundResult) {
      animateElimination(data.roundResult.eliminated);
    }

    // ✅ handle winners (optional)
    if (data.gameOver) {
      alert("Winners: " + data.gameOver.winners.join(", "));
    }
  }
};

ws.onclose = () => {
  document.getElementById("status").textContent = "Disconnected";
};

// ===============================
// SEND ANSWER
// ===============================

function answer(a) {
  if (!connected) return;
  if (state?.game?.locked) return;

  // ✅ Toggle behavior
  if (mySelectedAnswer === a) {
    mySelectedAnswer = null;

    ws.send(JSON.stringify({
      type: "selectAnswer",
      courseId,
      userId,
      answer: null
    }));
  } else {
    mySelectedAnswer = a;

    ws.send(JSON.stringify({
      type: "selectAnswer",
      courseId,
      userId,
      answer: a
    }));
  }

  updateAnswerButtons();
}

// ===============================
// RENDER BOARD
// ===============================

function render() {
  // -------------------------------
  // Lock status banner
  // -------------------------------
  const lockStatus = document.getElementById("lockStatus");
  if (lockStatus) {
    if (state?.game?.locked) {
      lockStatus.classList.remove("hidden");
    } else {
      lockStatus.classList.add("hidden");
    }
  }

  // -------------------------------
  // Board rebuild (PURE rendering)
  // -------------------------------
  const board = document.getElementById("board");
  board.innerHTML = "";

  const players = state?.game?.players || {};
  const animatingIds = Array.isArray(state.eliminatedIds)
    ? state.eliminatedIds
    : [];

  Object.entries(players).forEach(([id, p]) => {
    const div = document.createElement("div");
    div.className = "slot";
    div.dataset.id = id;

    if (id === userId) {
      div.classList.add("me");
    }

    if (p.lockedIn) {
      div.classList.add("locked");
    }

    // ✅ KEY FIX:
    // Only apply .eliminated if NOT being animated right now
    if (p.eliminated && !animatingIds.includes(id)) {
      div.classList.add("eliminated");
    }

    div.innerHTML = `
      <div class="avatar-wrapper">
        <img src="${p.avatar || ""}" />
      </div>
      <div class="name">${p.name || id}</div>
    `;

    board.appendChild(div);
  });

  // -------------------------------
  // Elimination animation
  // (ONLY when Finalize sends IDs)
  // -------------------------------
  if (animatingIds.length > 0) {
    animateElimination(animatingIds);
  }

  // -------------------------------
  // Sync this student's answer state
  // -------------------------------
  const me = state?.game?.players?.[userId];
  mySelectedAnswer = me?.answer ?? null;
  updateAnswerButtons();

  // -------------------------------
  // Enable / disable answer buttons
  // -------------------------------
  document.querySelectorAll(".answers button").forEach(btn => {
    btn.disabled = state?.game?.locked === true;
  });

  // -------------------------------
  // End-game celebration
  // -------------------------------
  if (state.celebration && Array.isArray(state.winners) && !celebrating) {
    celebrating = true;

    state.winners.forEach(id => {
      const slot = document.querySelector(`.slot[data-id="${id}"]`);
      if (slot) {
        slot.classList.add("winner");
        applyRandomDanceStyle(slot); // ✅ RANDOMIZE HERE
      }
    });
    startConfetti();
  }

  // -------------------------------
  // Reset celebration when game restarts
  // -------------------------------
  if (!state.celebration && celebrating) {
    celebrating = false;

    // Remove winner dance classes
    document.querySelectorAll(".slot.winner").forEach(slot => {
      slot.classList.remove("winner");
    });
  }

}

// ===============================
// AVATAR HANDLING
// ===============================

function getAvatarFromSVG(svg) {
  if (!svg) return "";

  return "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(svg);
}

// ===============================
// OPTIONAL: ELIMINATION ANIMATION
// ===============================

function animateElimination(eliminatedIds) {
  // Ensure animation layer exists
  let layer = document.getElementById("animationLayer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "animationLayer";
    layer.style.position = "fixed";
    layer.style.top = "0";
    layer.style.left = "0";
    layer.style.width = "100vw";
    layer.style.height = "100vh";
    layer.style.pointerEvents = "none";
    layer.style.zIndex = "5000";
    document.body.appendChild(layer);
  }

  eliminatedIds.forEach(id => {
    const slot = document.querySelector(`.slot[data-id="${id}"]`);
    if (!slot) return;

    const avatar = slot.querySelector(".avatar-wrapper");
    if (!avatar) return;

    // Measure avatar position BEFORE moving it
    const rect = avatar.getBoundingClientRect();

    // Lock visual size + position
    avatar.style.position = "fixed";
    avatar.style.left = `${rect.left}px`;
    avatar.style.top = `${rect.top}px`;
    avatar.style.width = `${rect.width}px`;
    avatar.style.height = `${rect.height}px`;
    avatar.style.margin = "0";
    avatar.style.transform = "none";
    avatar.style.transformOrigin = "center";

    // Lift avatar above everything
    layer.appendChild(avatar);

    // Randomization
    const direction = Math.random() < 0.5 ? -1 : 1;
    const rotation = direction * (90 + Math.random() * 270);
    const fallDistance = 800;
    const duration = 1.8;

    // Apply CSS variables
    avatar.style.setProperty("--spin-deg", `${rotation}deg`);
    avatar.style.setProperty("--fall-distance", `${fallDistance}px`);
    avatar.style.setProperty("--fall-duration", `${duration}s`);

    // Trigger animation
    avatar.classList.add("falling");

    // Cleanup (use both animationend AND timeout as safety)
    const cleanup = () => {
      avatar.removeEventListener("animationend", cleanup);

      avatar.classList.remove("falling");

      // Reset inline styles
      avatar.style.position = "";
      avatar.style.left = "";
      avatar.style.top = "";
      avatar.style.width = "";
      avatar.style.height = "";
      avatar.style.margin = "";
      avatar.style.transform = "";
      avatar.style.transformOrigin = "";

      // Return avatar to slot
      slot.prepend(avatar);

      // Final visual state
      slot.classList.add("eliminated");
    };

    avatar.addEventListener("animationend", cleanup, { once: true });

    // Fallback in case animationend doesn’t fire
    setTimeout(cleanup, duration * 1000 + 50);
  });
}

function updateAnswerButtons() {
  document.querySelectorAll(".answers button").forEach(btn => {
    const val = btn.dataset.answer;

    if (val === mySelectedAnswer) {
      btn.classList.add("selected");
    } else {
      btn.classList.remove("selected");
    }
  });
}

function startConfetti() {
  if (confettiRunning) return;
  confettiRunning = true;

  const canvas = document.getElementById("confettiCanvas");
  const ctx = canvas.getContext("2d");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.display = "block";

  const pieces = Array.from({ length: 120 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    r: Math.random() * 6 + 4,
    vy: Math.random() * 3 + 2,
    vx: Math.random() * 2 - 1,
    color: `hsl(${Math.random() * 360}, 80%, 60%)`
  }));

  let frameId;

  function update() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    pieces.forEach(p => {
      p.y += p.vy;
      p.x += p.vx;
      if (p.y > canvas.height) p.y = -10;

      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });

    frameId = requestAnimationFrame(update);
  }

  update();

  // ✅ Stop automatically after 6 seconds
  setTimeout(() => {
    cancelAnimationFrame(frameId);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = "none";
    confettiRunning = false;
  }, 12000);
}

function applyRandomDanceStyle(slot) {
  const avatar = slot.querySelector(".avatar-wrapper");
  if (!avatar) return;

  // Random bounce height: 6–14px
  const bounce = 6 + Math.random() * 8;

  // Random tilt: 3–10deg, random direction
  const tilt = (3 + Math.random() * 7) * (Math.random() < 0.5 ? -1 : 1);

  // Random speed: 0.6–1.0 seconds
  const speed = 0.6 + Math.random() * 0.4;

  avatar.style.setProperty("--dance-bounce", `${bounce}px`);
  avatar.style.setProperty("--dance-tilt", `${tilt}deg`);
  avatar.style.setProperty("--dance-speed", `${speed}s`);
}

function uploadAvatar(file) {
  if (!file) return;

  // Basic client-side sanity check
  if (!file.type.startsWith("image/")) {
    alert("Please upload an image file.");
    return;
  }

  const formData = new FormData();
  formData.append("avatar", file);
  formData.append("courseId", courseId);
  formData.append("userId", userId);

  fetch("/upload-avatar", {
    method: "POST",
    body: formData
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        // Force state refresh (simplest approach)
        // Instructor & students will see it on next broadcast
        console.log("Avatar uploaded");
      } else {
        alert("Upload failed.");
      }
    })
    .catch(err => {
      console.error("Upload error", err);
      alert("Upload failed.");
    });
}