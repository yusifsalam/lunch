import { actions } from "astro:actions";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AuthUser } from "@/lib/authCookie";
import type { Snapshot } from "@/lib/sessionService";

interface Props {
  initial: Snapshot;
  user: AuthUser;
}

const MODES = [
  { value: "democracy", label: "🗳️ Democracy" },
  { value: "dictatorship", label: "👑 Dictatorship" },
  { value: "random", label: "🎲 Random" },
] as const;

export default function SessionView({ initial, user }: Props) {
  const [snap, setSnap] = useState<Snapshot>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  async function refresh() {
    try {
      const res = await fetch("/api/session/today");
      if (res.status === 401) {
        location.href = "/login";
        return;
      }
      if (res.ok) setSnap(await res.json());
    } catch {
      // transient network error — next poll retries
    }
  }

  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  async function call(fn: () => Promise<{ error?: { message: string } }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    if (error) setError(error.message);
    await refresh();
    setBusy(false);
  }

  const { session, participants, votes, myVote, places } = snap;
  if (!session) {
    return (
      <div class="card bg-base-100 shadow-sm">
        <div class="card-body items-center py-16 text-center">
          <span class="text-4xl">🏖️</span>
          <p class="text-lg">No lunch session today — it's the weekend.</p>
          {user.role === "admin" && (
            <button
              class="btn btn-primary btn-sm mt-2"
              disabled={busy}
              onClick={() => call(() => actions.lunch.forceStart())}
            >
              Start a session anyway
            </button>
          )}
          {error && <div class="alert alert-error text-sm">{error}</div>}
        </div>
      </div>
    );
  }

  const isAdmin = user.role === "admin";
  const open = session.status === "open";
  const joined = participants.some(
    (p) => p.name.toLowerCase() === user.name.toLowerCase(),
  );
  const isDictator =
    session.dictator_name?.toLowerCase() === user.name.toLowerCase();
  const activePlaces = places.filter((p) => !p.archived && !p.closedReason);
  const closedPlaces = places.filter((p) => !p.archived && p.closedReason);
  const placeName = (id: number | null) =>
    places.find((p) => p.id === id)?.name ?? "?";
  const votesFor = (placeId: number) =>
    votes.find((v) => v.placeId === placeId);

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <h1 class="text-2xl font-bold">
            {new Date(session.date + "T00:00:00").toLocaleDateString("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </h1>
          <span class="badge badge-primary">
            {MODES.find((m) => m.value === session.mode)?.label}
          </span>
          {!open && <span class="badge badge-success">decided</span>}
          <a
            href={`/sessions/${session.public_id}`}
            class="badge badge-ghost badge-sm"
            title="Permalink to this session"
          >
            #{session.public_id}
          </a>
        </div>
        {joined ? (
          <button
            class="btn btn-outline btn-sm"
            disabled={busy}
            onClick={() => call(() => actions.lunch.leave())}
          >
            Leave
          </button>
        ) : (
          <button
            class="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => call(() => actions.lunch.join())}
          >
            {open ? "Join lunch" : "Join anyway"}
          </button>
        )}
      </div>

      {error && <div class="alert alert-error text-sm">{error}</div>}

      {!open && (
        <div class="card bg-success/10 border-success border shadow-sm">
          <div class="card-body items-center py-8 text-center">
            <p class="text-base-content/70 text-sm">Today we're eating at</p>
            <p class="text-3xl font-bold">
              {(() => {
                const chosen = places.find(
                  (p) => p.id === session.chosen_place_id,
                );
                return chosen ? (
                  <a href={`/places/${chosen.slug}`} class="hover:link">
                    {chosen.name}
                  </a>
                ) : (
                  placeName(session.chosen_place_id)
                );
              })()}
            </p>
            {isAdmin && (
              <button
                class="btn btn-ghost btn-sm mt-2"
                disabled={busy}
                onClick={() => call(() => actions.lunch.reopen())}
              >
                Reopen
              </button>
            )}
          </div>
        </div>
      )}

      {open && session.mode === "democracy" && (
        <div class="card bg-base-100 shadow-sm">
          <div class="card-body">
            <h2 class="card-title text-lg">Vote for a place</h2>
            {activePlaces.length === 0 && (
              <p class="text-base-content/60">
                No places yet —{" "}
                <a href="/places" class="link">
                  add some first
                </a>
                .
              </p>
            )}
            <ul class="flex flex-col gap-2">
              {activePlaces.map((place) => {
                const v = votesFor(place.id);
                const mine = myVote === place.id;
                return (
                  <li key={place.id}>
                    <button
                      class={`btn w-full justify-between ${mine ? "btn-primary" : "btn-ghost bg-base-200"}`}
                      disabled={busy}
                      onClick={() =>
                        call(() =>
                          mine
                            ? actions.lunch.unvote()
                            : actions.lunch.vote({ placeId: place.id }),
                        )
                      }
                    >
                      <span>
                        {place.name}
                        {place.cuisine && (
                          <span class="badge badge-ghost badge-sm ml-2">
                            {place.cuisine}
                          </span>
                        )}
                      </span>
                      <span class="flex items-center gap-2">
                        {v && v.count > 0 && (
                          <span
                            class="text-xs opacity-70"
                            title={v.voters.join(", ")}
                          >
                            {v.voters.join(", ")}
                          </span>
                        )}
                        <span class="badge badge-neutral">{v?.count ?? 0}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {closedPlaces.map((place) => {
                const v = votesFor(place.id);
                return (
                  <li key={place.id}>
                    <div class="btn btn-disabled w-full justify-between">
                      <span>
                        {place.name}
                        <span class="badge badge-ghost badge-sm ml-2">
                          {place.closedReason}
                        </span>
                      </span>
                      <span class="badge badge-neutral">{v?.count ?? 0}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {open && session.mode === "dictatorship" && (
        <div class="card bg-base-100 shadow-sm">
          <div class="card-body">
            <h2 class="card-title text-lg">
              👑 {session.dictator_name ?? "No dictator designated yet"}
            </h2>
            {isDictator ? (
              <>
                <p class="text-base-content/70 text-sm">
                  You are today's dictator. Choose wisely — everyone eats where
                  you say.
                </p>
                <ul class="flex flex-col gap-2">
                  {activePlaces.map((place) => (
                    <li key={place.id}>
                      <button
                        class="btn btn-ghost bg-base-200 w-full justify-start"
                        disabled={busy}
                        onClick={() =>
                          call(() =>
                            actions.lunch.dictatorPick({ placeId: place.id }),
                          )
                        }
                      >
                        {place.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p class="text-base-content/70">
                {session.dictator_name
                  ? `Waiting for ${session.dictator_name} to pick a place.`
                  : "An admin needs to designate today's dictator."}
              </p>
            )}
          </div>
        </div>
      )}

      {open && session.mode === "random" && (
        <div class="card bg-base-100 shadow-sm">
          <div class="card-body items-center py-8 text-center">
            <span class="text-4xl">🎲</span>
            <p class="text-base-content/70">
              Fate decides today. {activePlaces.length} places in the draw —
              {isAdmin
                ? " hit Decide when everyone's in."
                : " an admin rolls the dice when everyone's in."}
            </p>
          </div>
        </div>
      )}

      <div class="card bg-base-100 shadow-sm">
        <div class="card-body py-4">
          <h2 class="text-sm font-semibold uppercase opacity-60">
            Who's in ({participants.length})
          </h2>
          {participants.length === 0 ? (
            <p class="text-base-content/60 text-sm">
              Nobody yet. Be the first!
            </p>
          ) : (
            <div class="flex flex-wrap gap-1">
              {participants.map((p) => (
                <span key={p.name} class="badge badge-outline">
                  {p.name}
                  {session.dictator_name?.toLowerCase() ===
                    p.name.toLowerCase() && " 👑"}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {isAdmin && open && (
        <div class="card border-warning bg-base-100 border shadow-sm">
          <div class="card-body py-4">
            <h2 class="text-sm font-semibold uppercase opacity-60">
              Admin controls
            </h2>
            <div class="flex flex-wrap items-center gap-2">
              <select
                class="select select-bordered select-sm"
                disabled={busy}
                value={session.mode}
                onChange={(e) =>
                  call(() =>
                    actions.lunch.setMode({
                      mode: e.currentTarget.value as
                        "democracy" | "dictatorship" | "random",
                    }),
                  )
                }
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              {session.mode === "dictatorship" && (
                <select
                  class="select select-bordered select-sm"
                  disabled={busy}
                  value={session.dictator_name ?? ""}
                  onChange={(e) => {
                    const name = e.currentTarget.value;
                    if (name) {
                      call(() => actions.lunch.setDictator({ name }));
                    }
                  }}
                >
                  <option value="">Pick a dictator…</option>
                  {participants.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              {session.mode !== "dictatorship" && (
                <button
                  class="btn btn-warning btn-sm"
                  disabled={busy}
                  onClick={() => call(() => actions.lunch.finalize())}
                >
                  {session.mode === "random" ? "🎲 Decide" : "Finalize"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
