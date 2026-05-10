const protocol = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${protocol}://${location.host}`);

const urlParams = new URLSearchParams(window.location.search);
const courseId = urlParams.get("courseId") || "abc";

let state = null;
let confettiRunning = false;
let celebrating = false;

// ===============================
// CONNECTION
// ===============================

ws.onopen = () => {
  console.log("WS OPEN");
  connected = true;

  ws.send(JSON.stringify({
    type: "join",
    courseId,
    userId: "instructor"
  }));
};

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);

  if (data.type === "state") {
    state = data;
    render();
  }

  if (data.type === "noCorrectAnswers") {
    showNoCorrectAnswersOverlay(msg.message);
    return;
  }
};

ws.onclose = () => {
  console.log("WS CLOSED");
};

ws.onerror = (err) => {
  console.log("WS ERROR", err);
};

// ===============================
// SEND HELPERS
// ===============================

function send(type, extra = {}) {
  if (!connected) return;

  ws.send(JSON.stringify({
    type,
    courseId,
    ...extra
  }));
}

function lock() { send("lock"); }
function unlock() { send("unlock"); }
function setCorrect(answer) { send("setCorrect", { answer }); }
function finalize() { send("finalize"); }
function declareWinners() { send("declareWinners"); }

// ===============================
// RENDER BOARD
// ===============================

function render() {
  if (!state || !state.game) return;

  // ---------------------------------
  // Correct-answer status + finalize gate
  // ---------------------------------
  const answerStatus = document.getElementById("answerStatus");
  const finalizeBtn = document.getElementById("finalizeBtn");

  if (state.game.correctAnswer != null) {
    answerStatus.textContent = "✅ Correct answer set";
    finalizeBtn.disabled = false;
  } else {
    answerStatus.textContent = "❌ Correct answer not set";
    finalizeBtn.disabled = true;
  }

  // ---------------------------------
  // Board rebuild
  // ---------------------------------
  const board = document.getElementById("board");
  board.innerHTML = "";

  const players = state.game.players || {};
  const animatingIds = Array.isArray(state.eliminatedIds)
    ? state.eliminatedIds
    : [];

  Object.entries(players).forEach(([id, p]) => {
    const div = document.createElement("div");
    div.className = "slot";
    div.dataset.id = id;

    // ✅ Answered indicator (NO answer text)
    if (p.answer != null) {
      div.classList.add("answered");
    }

    if (p.lockedIn) {
      div.classList.add("locked");
    }

    // ✅ Apply eliminated only if NOT being animated
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

  // ---------------------------------
  // Elimination animation (Finalize only)
  // ---------------------------------
  if (animatingIds.length > 0) {
    animateElimination(animatingIds);
  }

  // ---------------------------------
  // End‑game celebration
  // ---------------------------------
  if (state.celebration && Array.isArray(state.winners) && !celebrating) {
    celebrating = true;

    state.winners.forEach(id => {
      const slot = document.querySelector(`.slot[data-id="${id}"]`);
      if (slot) {
        slot.classList.add("winner");
        applyRandomDanceStyle(slot);
      }
    });

    startConfetti();
  }

  // ---------------------------------
  // Celebration reset on new game
  // ---------------------------------
  if (!state.celebration && celebrating) {
    celebrating = false;

    document.querySelectorAll(".slot.winner").forEach(slot => {
      slot.classList.remove("winner");
    });
  }
}

// ===============================
// ROUND RESULT VISUAL
// ===============================

function animateElimination(eliminatedIds) {
  eliminatedIds.forEach(id => {
    const slot = document.querySelector(`.slot[data-id="${id}"]`);
    if (!slot) return;

    const avatar = slot.querySelector(".avatar-wrapper");
    if (!avatar) return;

    // Randomized fall settings (same as student)
    const direction = Math.random() < 0.5 ? -1 : 1;
    const rotation = direction * (90 + Math.random() * 270);
    const fallDistance = 800;
    const duration = 1.8;

    avatar.style.setProperty("--spin-deg", `${rotation}deg`);
    avatar.style.setProperty("--fall-distance", `${fallDistance}px`);
    avatar.style.setProperty("--fall-duration", `${duration}s`);

    slot.classList.add("falling");

    setTimeout(() => {
      slot.classList.remove("falling");
      slot.classList.add("eliminated");
    }, duration * 1000);
  });
}


// ===============================
// AVATAR HANDLING
// ===============================

function getAvatarFromSVG(svg) {
  if (!svg) return "";

  return "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(svg);
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

function getCourseIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get("courseId");
}

function populateLeaderboard(leaderboard) {
  const modal = document.getElementById("leaderboardModal");

  modal.innerHTML = `
    <div onclick="event.stopPropagation()">
      <button class="modal-close" onclick="hideLeaderboard()">✕</button>

      <h2>Leaderboard</h2>

      <table id="leaderboard">
        <thead>
          <tr>
            <th>Name</th>
            <th>Wins</th>
          </tr>
        </thead>
        <tbody>
          ${leaderboard.map(p => `
            <tr>
              <td>${p.name}</td>
              <td>${p.wins}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  modal.classList.remove("hidden");
}

async function showLeaderboard() {
  const courseId = getCourseIdFromURL();

  if (!courseId) {
    console.error("courseId missing from URL");
    return;
  }

  const res = await fetch(`/api/classes/${courseId}/leaderboard`);
  if (!res.ok) {
    console.error("Failed to load leaderboard");
    return;
  }

  const { leaderboard } = await res.json();
  populateLeaderboard(leaderboard);
}

function hideLeaderboard() {
  document.getElementById("leaderboardModal").classList.add("hidden");
}

function showNoCorrectAnswersOverlay(text) {
  const modal = document.getElementById("leaderboardModal");

  modal.innerHTML = `
    <div onclick="event.stopPropagation()">
      <button class="modal-close" onclick="hideLeaderboard()">✕</button>

      <h2>Notice</h2>

      <div style="text-align:center; font-size:18px; margin-top:10px;">
        ❌ <strong>No one answered correctly</strong>
        <br><br>
        ${text || "You may discuss the question and decide how to continue."}
      </div>
    </div>
  `;

  modal.classList.remove("hidden");
}
