// ===============================
// STARTER SERVER FOR CLASSROOM GAME
// ===============================
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require("crypto");
const lti = require("ims-lti");
const querystring = require("querystring");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
let cachedRoster = null;
const LTI_KEY = process.env.LTI_KEY;
const LTI_SECRET = process.env.LTI_SECRET;


app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));
app.set("trust proxy", true);
app.use("/avatars", express.static(path.join(__dirname, "avatars")));

process.on('uncaughtException', (err) => {
  console.error("\n💥 UNCAUGHT EXCEPTION:");
  console.error(err);
});

process.on('unhandledRejection', (err) => {
  console.error("\n💥 UNHANDLED REJECTION:");
  console.error(err);
});

// ===============================
// FILE STORAGE
// ===============================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "avatars/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = crypto.randomUUID() + ext;
    cb(null, filename);
  }
});


const upload = multer({
  storage,
  limits: { fileSize: 200000 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"));
    }
  }
});

const DATA_DIR = process.env.DATA_DIR || "/data/classes";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure avatars directory exists
if (!fs.existsSync("avatars")) {
  fs.mkdirSync("avatars", { recursive: true });
}

function loadClass(courseId) {
  const file = getClassFile(courseId);

  try {
    if (!fs.existsSync(file)) {
      const cls = {
        students: {},
        game: createNewGame()
      };
      fs.writeFileSync(file, JSON.stringify(cls, null, 2));
      return cls;
    }

    const raw = fs.readFileSync(file, "utf8");

    if (!raw || raw.trim() === "") {
      const cls = {
        students: {},
        game: createNewGame()
      };
      fs.writeFileSync(file, JSON.stringify(cls, null, 2));
      return cls;
    }

    const cls = JSON.parse(raw);

    cls.students ??= {};
    cls.game ??= createNewGame();
    cls.game.players ??= {};

    return cls;

  } catch (err) {
    console.log("⚠️ Class file corrupted, repairing:", courseId);

    const cls = {
      students: {},
      game: createNewGame()
    };

    fs.writeFileSync(file, JSON.stringify(cls, null, 2));
    return cls;
  }
}

app.post("/lti/launch", (req, res) => {
  const provider = new lti.Provider(
    process.env.LTI_KEY,
    process.env.LTI_SECRET
  );

  provider.valid_request(req, (err, isValid) => {
    if (!isValid) {
      console.error("Invalid LTI launch:", err);
      return res.status(401).send("Invalid LTI launch");
    }

    const userId = req.body.user_id;
    const fullName = req.body.lis_person_name_full;
    const roles = req.body.roles;
    const canvasCourseId = req.body.context_id;
    const schoolId = req.body.tool_consumer_instance_guid;

    const sectionIds = req.body.custom_canvas_section_ids || "";
    const sectionNames = req.body.custom_canvas_section_names || "";

    const params = new URLSearchParams({
      userId,
      name: fullName,
      role: roles,
      baseCourseId: `${schoolId}_${canvasCourseId}`,
      sectionIds,
      sectionNames
    });

    res.redirect(`/launch?${params.toString()}`);
  });
});

app.get("/api/classes/:className/leaderboard", (req, res) => {
  const { className } = req.params;

  // Basic safety check to avoid path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(className)) {
    return res.status(400).json({ error: "Invalid class name" });
  }

  const filePath = path.join(
    __dirname,
    "data",
    "classes",
    `${className}.json`
  );

  fs.readFile(filePath, "utf8", (err, raw) => {
    if (err) {
      if (err.code === "ENOENT") {
        return res.status(404).json({ error: "Class not found" });
      }
      console.error(err);
      return res.status(500).json({ error: "Failed to read class file" });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      console.error(parseErr);
      return res.status(500).json({ error: "Invalid JSON in class file" });
    }

    if (!data.students || typeof data.students !== "object") {
      return res.status(500).json({ error: "Invalid class data format" });
    }

    const leaderboard = Object.entries(data.students)
      .map(([id, student]) => ({
        id,
        name: student.name,
        wins: student.wins ?? 0
      }))
      .sort((a, b) => b.wins - a.wins); // optional

    res.json({ leaderboard });
  });
});

// ===============================
// AVATAR UPLOAD
// ===============================

app.post("/upload-avatar", upload.single("avatar"), (req, res) => {
  const { courseId, userId } = req.body;

  if (!courseId || !userId) {
    return res.status(400).json({ success: false });
  }

  const cls = loadClass(courseId);
  if (!cls.students[userId]) {
    return res.status(400).json({ success: false });
  }

  cls.students[userId].avatar = `/avatars/${req.file.filename}`;
  saveClass(courseId, cls);

  res.json({ success: true });
});

// ===============================
// DEFAULT AVATAR
// ===============================


const defaultAvatarSVG = fs.readFileSync(
  path.join(__dirname, "public/default_avatar.svg"),
  "utf8"
);

function generateAvatar(userId) {
  const colors = generateColors(userId);

  const newAvatar = defaultAvatarSVG
    .replaceAll("SKIN_COLOR", colors.skin)
    .replaceAll("HAIR_COLOR", colors.hair)
    .replaceAll("EYE_COLOR", colors.eyes);
  return newAvatar;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function generateColors(userId, courseId) {
  const seed = makeSeed(userId, courseId);

  return {
    skin: colorFromSeed(seed, 1),
    hair: colorFromSeed(seed, 2),
    eyes: colorFromSeed(seed, 3),
  };
}

function makeSeed(userId, courseId) {
  const base = `${courseId}:${userId}`;

  // add entropy so sequential IDs don't cluster
  let hash = 2166136261; // FNV offset basis

  for (let i = 0; i < base.length; i++) {
    hash ^= base.charCodeAt(i);
    hash *= 16777619;
  }

  // extra scrambling step
  hash ^= hash << 13;
  hash ^= hash >>> 17;
  hash ^= hash << 5;

  return hash >>> 0;
}

function colorFromSeed(seed, offset) {
  const x = Math.sin(seed + offset * 9999) * 10000;
  const hue = Math.floor((x - Math.floor(x)) * 360);
  return `hsl(${hue}, 60%, 60%)`;
}
// ===============================
// LTI MOCK ROUTE (REPLACE LATER)
// ===============================

app.get('/launch', (req, res) => {
  const { userId, name, role, baseCourseId, sectionIds, sectionNames } = req.query;

  const isInstructor =
    role.includes("Instructor") || role.includes("Teacher");

  // ✅ STUDENT FLOW
  if (!isInstructor) {
    const sectionId = sectionIds?.split(",")[0] || "no-section";
    const courseId = `${baseCourseId}_${sectionId}`;

    const cls = loadClass(courseId);

    if (!cls.students[userId]) {
      if (!cls.game.players[userId]) {
        cls.game.players[userId] = {
          answer: null,
          lockedIn: false,
          eliminated: false
        };
      }
      cls.students[userId] = {
        name,
        avatarSVG: generateAvatar(userId),
        wins: 0
      };
    }

    saveClass(courseId, cls);

    return res.sendFile(path.join(__dirname, 'public/student.html'));
  }

  // ✅ INSTRUCTOR FLOW
  const sectionIdsArr = sectionIds ? sectionIds.split(",") : [];
  const sectionNamesArr = sectionNames ? sectionNames.split(",") : [];

  // ✅ NEW: If only one section → skip selector entirely
  if (sectionIdsArr.length === 1) {
    const courseId = `${baseCourseId}_${sectionIdsArr[0]}`;

    const cls = loadClass(courseId);
    saveClass(courseId, cls);

    return res.sendFile(path.join(__dirname, 'public/instructor.html'));
  }

  // ✅ EXISTING: Only runs if MULTIPLE sections
  return res.send(`
    <html>
      <body>
        <h2>Select a Class Section</h2>
        ${sectionIdsArr.map((id, i) => `
          <form method="GET" action="/instructor">
            <input type="hidden" name="userId" value="${userId}" />
            <input type="hidden" name="name" value="${name}" />
            <input type="hidden" name="courseId" value="${baseCourseId}_${id}" />
            <button type="submit">
              ${sectionNamesArr[i] || `Section ${id}`}
            </button>
          </form>
        `).join("")}
      </body>
    </html>
  `);
});

app.get('/instructor', (req, res) => {
  const { courseId } = req.query;

  const cls = loadClass(courseId);
  saveClass(courseId, cls);

  res.sendFile(path.join(__dirname, 'public/instructor.html'));
});

// ===============================
// GAME STATE
// ===============================

function createNewGame() {
  return {
    phase: "playing",
    round: 1,
    locked: false,
    correctAnswer: null,
    eliminatedThisRound: [],
    players: {}
  };
}

// ===============================
// WEBSOCKETS
// ===============================

const rooms = {}; // courseId -> clients

  wss.on('connection', (ws) => {
    console.log("🟢 WS CONNECTED");

    ws.on('close', () => {
      if (ws.courseId && rooms[ws.courseId]) {
        rooms[ws.courseId].delete(ws);
      }
      console.log("🔴 WS CLOSED");
    });

    ws.on('error', (err) => {
      console.log("⚠️ WS ERROR:", err);
    });

  // message
  ws.on("message", (msg) => {
    console.log("📩 RAW MESSAGE:", msg.toString());

    let dataMsg;
    try {
      dataMsg = JSON.parse(msg);
    } catch (e) {
      console.log("❌ BAD JSON:", msg.toString());
      return;
    }

    const { type, courseId, userId } = dataMsg;
    console.log("📦 PARSED MESSAGE:", dataMsg);

    const cls = loadClass(courseId);
    if (!cls) return;

    // =================================================
    // JOIN
    // =================================================

    if (type === "join") {
      ws.courseId = courseId;
      ws.userId = userId;

      if (!rooms[courseId]) rooms[courseId] = new Set();
      rooms[courseId].add(ws);

      // Only students participate in the game
      if (userId !== "instructor") {
        cls.game.players[userId] ??= {
          answer: null,
          lockedIn: false,
          eliminated: false
        };
      }

      saveClass(courseId, cls);
      broadcast(courseId, {
        type: "state",
        ...buildGameView(cls)
      });

      console.log("✅ JOIN COMPLETE", userId);
      return;
    }

    const game = cls.game;
    if (!game) return;

    // =================================================
    // LOCK / UNLOCK
    // =================================================

    if (type === "lock") {
      game.locked = true;
      Object.values(game.players).forEach(p => p.lockedIn = true);

      saveClass(courseId, cls);
      broadcast(courseId, { type: "state", ...buildGameView(cls) });
      return;
    }

    if (type === "unlock") {
      game.locked = false;
      Object.values(game.players).forEach(p => p.lockedIn = false);

      saveClass(courseId, cls);
      broadcast(courseId, { type: "state", ...buildGameView(cls) });
      return;
    }

    // =================================================
    // SET CORRECT ANSWER
    // =================================================

    if (type === "setCorrect") {
      game.correctAnswer = dataMsg.answer ?? null;

      saveClass(courseId, cls);
      broadcast(courseId, { type: "state", ...buildGameView(cls) });
      return;
    }

    // =================================================
    // STUDENT SELECT ANSWER
    // =================================================

    if (type === "selectAnswer") {
      if (game.locked) return;
      if (!game.players[userId]) return;

      game.players[userId].answer = dataMsg.answer;

      saveClass(courseId, cls);
      broadcast(courseId, { type: "state", ...buildGameView(cls) });
      return;
    }

    // =================================================
    // FINALIZE ROUND (⚠️ DOES NOT END GAME)
    // =================================================

    if (type === "finalize") {
      const correct = game.correctAnswer;

      const activePlayers = Object.entries(game.players)
        .filter(([_, p]) => !p.eliminated);

      const correctIds = activePlayers
        .filter(([_, p]) => p.answer != null && p.answer === correct)
        .map(([id]) => id);

      // ✅ CASE: NO ONE GOT IT RIGHT
      if (correctIds.length === 0) {
        // Reset per-round fields, but eliminate nobody
        game.locked = false;
        game.correctAnswer = null;

        Object.values(game.players).forEach(p => {
          p.answer = null;
          p.lockedIn = false;
        });

        saveClass(courseId, cls);

        // 🔔 Explicit notification event
        broadcast(courseId, {
          type: "noCorrectAnswers",
          message: "No one answered correctly. Instructor may choose what to do next."
        });

        // Also broadcast refreshed state
        broadcast(courseId, {
          type: "state",
          ...buildGameView(cls)
        });

        return;
      }

      // ✅ NORMAL CASE: eliminate incorrect players
      const eliminatedNow = [];

      activePlayers.forEach(([id, p]) => {
        if (p.answer !== correct) {
          p.eliminated = true;
          eliminatedNow.push(id);
        }
      });

      game.locked = false;
      game.correctAnswer = null;

      Object.values(game.players).forEach(p => {
        p.answer = null;
        p.lockedIn = false;
      });

      saveClass(courseId, cls);

      broadcast(courseId, {
        type: "state",
        eliminatedIds: eliminatedNow, // animation hook
        ...buildGameView(cls)
      });

      return;
    }


    // =================================================
    // DECLARE WINNERS (paused end-of-game)
    // =================================================

    if (type === "declareWinners") {
      const winners = Object.entries(game.players)
        .filter(([_, p]) => !p.eliminated)
        .map(([id]) => id);

      winners.forEach(id => {
        if (cls.students[id]) {
          cls.students[id].wins = (cls.students[id].wins || 0) + 1;
        }
      });

      saveClass(courseId, cls);

      broadcast(courseId, {
        type: "state",
        winners,          // ✅ winners list
        celebration: true, // ✅ celebration trigger
        ...buildGameView(cls)
      });

      return;
    }

    // =================================================
    // START NEW GAME (manual reset)
    // =================================================

    if (type === "startNewGame") {
      const newGame = createNewGame();

      Object.keys(game.players).forEach(id => {
        newGame.players[id] = {
          answer: null,
          lockedIn: false,
          eliminated: false
        };
      });

      cls.game = newGame;

      saveClass(courseId, cls);
      broadcast(courseId, { type: "state", ...buildGameView(cls) });
      return;
    }
  });


});

// ===============================
// HELPERS
// ===============================
function buildGameView(cls) {
  const game = cls.game;
  const players = {};

  for (const id of Object.keys(game.players)) {
    const student = cls.students[id];

    players[id] = {
      ...game.players[id],
      name: student?.name || id,

      // ✅ Prefer uploaded avatar, fallback to SVG
      avatar:
        student?.avatar
          ? student.avatar
          : student?.avatarSVG
            ? "data:image/svg+xml;charset=utf-8," +
              encodeURIComponent(student.avatarSVG)
            : null
    };
  }

  return {
    game: {
      ...game,
      players
    }
  };
}

function broadcast(courseId, message) {
  console.log("ROOM SIZE:", rooms[courseId]?.size);

  rooms[courseId]?.forEach(client => {
    console.log("CLIENT STATE:", client.readyState);

    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function checkWin(courseId) {
  const cls = loadClass(courseId);
  const game = cls.game;

  const active = Object.entries(game.players)
    .filter(([_, p]) => !p.eliminated)
    .map(([id]) => id);

  if (active.length === 0) {
    const all = Object.keys(game.players);
    declareWinners(courseId, all);
  } else if (active.length <= 1) {
    declareWinners(courseId, active);
  }
}

function declareWinners(courseId, winners = null) {
  const cls = loadClass(courseId);
  const oldGame = cls.game;

  // ✅ Determine winners if not explicitly provided
  if (!winners) {
    winners = Object.entries(oldGame.players)
      .filter(([_, p]) => !p.eliminated)
      .map(([id]) => id);
  }

  // ✅ Increment win counts (DO NOT reset these)
  winners.forEach(id => {
    const student = cls.students[id];
    if (student) {
      student.wins = (student.wins || 0) + 1;
    }
  });

  // ✅ Start a brand-new game
  const newGame = createNewGame();

  // ✅ Re-add ALL known players (everyone is back in)
  Object.keys(oldGame.players).forEach(id => {
    newGame.players[id] = {
      answer: null,
      lockedIn: false,
      eliminated: false
    };
  });

  cls.game = newGame;

  saveClass(courseId, cls);

  // ✅ Broadcast the reset game state
  broadcast(courseId, {
    type: "state",
    ...buildGameView(cls)
  });
}

function sanitize(id) {
  return id.replace(/[^a-z0-9_-]/gi, "_");
}

function getClassFile(courseId) {
  return path.join(DATA_DIR, `${sanitize(courseId)}.json`);
}

function loadClass(courseId) {
  const file = getClassFile(courseId);

  try {
    if (!fs.existsSync(file)) {
      const cls = {
        students: {},
        game: createNewGame()
      };
      fs.writeFileSync(file, JSON.stringify(cls, null, 2));
      return cls;
    }

    const raw = fs.readFileSync(file, "utf8");

    if (!raw || raw.trim() === "") {
      const cls = {
        students: {},
        game: createNewGame()
      };
      fs.writeFileSync(file, JSON.stringify(cls, null, 2));
      return cls;
    }

    const cls = JSON.parse(raw);

    // repair structure if needed
    cls.students ??= {};
    cls.game ??= createNewGame();
    cls.game.players ??= {};

    return cls;

  } catch (err) {
    console.log("⚠️ Class file corrupted, repairing:", courseId);

    const cls = {
      students: {},
      game: createNewGame()
    };

    fs.writeFileSync(file, JSON.stringify(cls, null, 2));
    return cls;
  }
}

function saveClass(courseId, cls) {
  const file = getClassFile(courseId);
  fs.writeFileSync(file, JSON.stringify(cls, null, 2));
}


// ===============================
// START SERVER
// ===============================

const port = process.env.PORT || 8080;

server.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on ${port}`);
});
