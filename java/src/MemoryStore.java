/**
 * Conversation Memory — Java
 * JSON-backed session store (Jackson only, no Java serialization/ObjectInputStream).
 * Loading a session file cannot execute code — JSON deserialization to plain POJOs only.
 * Path traversal protected via strict session ID allowlist.
 */

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

public class MemoryStore {

    static final ObjectMapper JSON = new ObjectMapper();
    static final Pattern SAFE_ID   = Pattern.compile("^[a-zA-Z0-9\\-]{1,64}$");

    // ── Session POJO ──────────────────────────────────────────────────────────
    public static class Session {
        @JsonProperty("session_id")  public String sessionId;
        @JsonProperty("created_at")  public double createdAt;
        @JsonProperty("updated_at")  public double updatedAt;
        @JsonProperty("messages")    public List<Map<String, Object>> messages = new ArrayList<>();
        @JsonProperty("summary")     public String summary = "";
        @JsonProperty("metadata")    public Map<String, String> metadata = new LinkedHashMap<>();

        public Session() {}

        public static Session create(String sessionId, Map<String, String> metadata) {
            Session s = new Session();
            double now = Instant.now().toEpochMilli() / 1000.0;
            s.sessionId = sessionId;
            s.createdAt = now;
            s.updatedAt = now;
            s.metadata  = metadata != null ? metadata : new LinkedHashMap<>();
            return s;
        }

        public Map<String, Object> toAssistantMessage() {
            return Map.of("role", "assistant", "content", summary);
        }
    }

    // ── Store ─────────────────────────────────────────────────────────────────
    private final Path dir;
    private final ReentrantLock lock = new ReentrantLock();

    public MemoryStore(String dir) throws IOException {
        this.dir = Path.of(dir);
        Files.createDirectories(this.dir);
    }

    public MemoryStore() throws IOException {
        this(System.getenv().getOrDefault("RAG_SESSION_DIR",
            System.getProperty("user.dir") + "/.rag_sessions_java"));
    }

    private Path safePath(String sessionId) {
        if (sessionId == null || !SAFE_ID.matcher(sessionId).matches()) {
            throw new IllegalArgumentException("Invalid session_id: " + sessionId);
        }
        return dir.resolve(sessionId + ".json");
    }

    private static String newSessionId() {
        return UUID.randomUUID().toString().replace("-", "");
    }

    public Session create(Map<String, String> metadata) throws IOException {
        Session s = Session.create(newSessionId(), metadata);
        save(s);
        return s;
    }

    public Session load(String sessionId) throws IOException {
        Path path = safePath(sessionId);
        lock.lock();
        try {
            if (!Files.exists(path)) return null;
            return JSON.readValue(path.toFile(), Session.class);
        } finally {
            lock.unlock();
        }
    }

    public void save(Session session) throws IOException {
        session.updatedAt = Instant.now().toEpochMilli() / 1000.0;
        Path path = safePath(session.sessionId);
        Path tmp  = path.resolveSibling(session.sessionId + ".tmp");
        byte[] data = JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(session);
        lock.lock();
        try {
            Files.write(tmp, data, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            lock.unlock();
        }
    }

    public boolean delete(String sessionId) throws IOException {
        Path path = safePath(sessionId);
        lock.lock();
        try {
            return Files.deleteIfExists(path);
        } finally {
            lock.unlock();
        }
    }

    public List<String> listSessions() throws IOException {
        List<String> ids = new ArrayList<>();
        try (var stream = Files.list(dir)) {
            stream.forEach(p -> {
                String name = p.getFileName().toString();
                if (name.endsWith(".json") && !name.endsWith(".tmp")) {
                    ids.add(name.replace(".json", ""));
                }
            });
        }
        Collections.sort(ids);
        return ids;
    }

    public Session appendUser(String sessionId, String content) throws IOException {
        return append(sessionId, Map.of("role", "user", "content", content));
    }

    public Session appendAssistant(String sessionId, String content) throws IOException {
        return append(sessionId, Map.of("role", "assistant", "content", content));
    }

    private Session append(String sessionId, Map<String, Object> message) throws IOException {
        Session session = load(sessionId);
        if (session == null) {
            session = Session.create(sessionId, new LinkedHashMap<>());
        }
        session.messages.add(message);
        save(session);
        return session;
    }

    // ── Context builder ───────────────────────────────────────────────────────
    public static List<Map<String, Object>> buildContextMessages(Session session, String newUserMessage) {
        List<Map<String, Object>> msgs = new ArrayList<>();
        if (session.summary != null && !session.summary.isBlank()) {
            msgs.add(Map.of("role", "user", "content", "[Prior summary]: " + session.summary));
            msgs.add(Map.of("role", "assistant", "content", "Understood."));
        }
        msgs.addAll(session.messages);
        msgs.add(Map.of("role", "user", "content", newUserMessage));
        return msgs;
    }
}
