import { actions } from "astro:actions";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AuthUser } from "@/lib/authCookie";
import type { Snapshot } from "@/lib/lunchService";

interface Props {
  initial: Snapshot;
  user: AuthUser;
}

type Train = Snapshot["trains"][number];

const MODES = [
  { value: "democracy", label: "🗳️ Democracy" },
  { value: "dictatorship", label: "👑 Dictatorship" },
  { value: "random", label: "🎲 Random" },
] as const;

export default function SessionView({ initial, user }: Props) {
  const [snap, setSnap] = useState<Snapshot>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTrainName, setNewTrainName] = useState<string | null>(null);
  // Per-train collapse overrides; a train without an entry is open only when
  // it's first in the list (your train, else the default one).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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

  async function createTrain() {
    const name = newTrainName?.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    const { error } = await actions.lunch.createTrain({ name });
    if (error) setError(error.message);
    else setNewTrainName(null);
    await refresh();
    setBusy(false);
  }

  async function deleteTrain(session: Train["session"]) {
    if (!session.name) return; // the default train is reset via history, not here
    const sure = confirm(
      `Delete the "${session.name}" train? Its votes and participants are removed too.`,
    );
    if (!sure) return;
    // deleteSession is a form action (the history page posts it), so it takes FormData.
    const fd = new FormData();
    fd.set("publicId", session.public_id);
    await call(() => actions.lunch.deleteSession(fd));
  }

  const { trains, myTrain, myVote, places } = snap;

  if (trains.length === 0) {
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

  // Your train leads; otherwise keep the server order (default first, then
  // by creation time). Array.prototype.sort is stable.
  const ordered = [...trains].sort(
    (a, b) =>
      (a.session.public_id === myTrain ? 0 : 1) -
      (b.session.public_id === myTrain ? 0 : 1),
  );

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h1 class="text-2xl font-bold">
          {new Date(snap.date + "T00:00:00").toLocaleDateString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </h1>
        {newTrainName === null ? (
          <button
            class="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => setNewTrainName("")}
          >
            + New train
          </button>
        ) : (
          <form
            class="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              createTrain();
            }}
          >
            <input
              type="text"
              class="input input-bordered input-sm w-40"
              placeholder="Train name"
              maxlength={40}
              value={newTrainName}
              onInput={(e) => setNewTrainName(e.currentTarget.value)}
              autofocus
            />
            <button
              class="btn btn-primary btn-sm"
              disabled={busy}
              type="submit"
            >
              Start
            </button>
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              onClick={() => setNewTrainName(null)}
            >
              Cancel
            </button>
          </form>
        )}
      </div>

      {error && <div class="alert alert-error text-sm">{error}</div>}

      {ordered.map((t, i) => {
        const id = t.session.public_id;
        const isOpen = expanded[id] ?? i === 0;
        return (
          <TrainSection
            key={id}
            train={t}
            isExpanded={isOpen}
            onToggle={() => setExpanded({ ...expanded, [id]: !isOpen })}
            isMine={id === myTrain}
            hasTrain={myTrain !== null}
            myVote={id === myTrain ? myVote : null}
            places={places}
            user={user}
            busy={busy}
            call={call}
            onDelete={() => deleteTrain(t.session)}
          />
        );
      })}
    </div>
  );
}

function TrainSection(props: {
  train: Train;
  isExpanded: boolean;
  onToggle: () => void;
  isMine: boolean;
  hasTrain: boolean;
  myVote: number | null;
  places: Snapshot["places"];
  user: AuthUser;
  busy: boolean;
  call: (fn: () => Promise<{ error?: { message: string } }>) => Promise<void>;
  onDelete: () => void;
}) {
  const {
    train,
    isExpanded,
    onToggle,
    isMine,
    hasTrain,
    myVote,
    places,
    user,
    busy,
    call,
    onDelete,
  } = props;
  const { session, participants, votes } = train;

  const isAdmin = user.role === "admin";
  const canManage =
    isAdmin || session.created_by?.toLowerCase() === user.name.toLowerCase();
  const open = session.status === "open";
  const isDictator =
    session.dictator_name?.toLowerCase() === user.name.toLowerCase();
  const activePlaces = places.filter((p) => !p.archived && !p.closedReason);
  const closedPlaces = places.filter((p) => !p.archived && p.closedReason);
  const placeName = (id: number | null) =>
    places.find((p) => p.id === id)?.name ?? "?";
  const votesFor = (placeId: number) =>
    votes.find((v) => v.placeId === placeId);
  const chosen = places.find((p) => p.id === session.chosen_place_id);

  return (
    <section
      class={`collapse-arrow bg-base-100 collapse shadow-sm ${isExpanded ? "collapse-open" : "collapse-close"}`}
    >
      <div
        class="collapse-title flex min-h-0 cursor-pointer flex-wrap items-center gap-2 py-3"
        onClick={onToggle}
      >
        <span class="font-semibold">🚂 {session.name ?? "Lunch"}</span>
        {isMine && <span title="You're on this train">⭐</span>}
        <span class="badge badge-primary badge-sm">
          {MODES.find((m) => m.value === session.mode)?.label}
        </span>
        {!open && (
          <span class="badge badge-success badge-sm">
            decided: {placeName(session.chosen_place_id)}
          </span>
        )}
        <span class="badge badge-ghost badge-sm">
          {participants.length} {participants.length === 1 ? "rider" : "riders"}
        </span>
        <span class="ml-auto" onClick={(e) => e.stopPropagation()}>
          {isMine ? (
            <button
              class="btn btn-outline btn-xs"
              disabled={busy}
              onClick={() =>
                call(() => actions.lunch.leave({ trainId: session.public_id }))
              }
            >
              Leave
            </button>
          ) : (
            <button
              class="btn btn-primary btn-xs"
              disabled={busy}
              onClick={() =>
                call(() => actions.lunch.join({ trainId: session.public_id }))
              }
            >
              {hasTrain
                ? "Switch to this train"
                : open
                  ? "Join"
                  : "Join anyway"}
            </button>
          )}
        </span>
      </div>
      <div class="collapse-content">
        <div class="flex flex-col gap-3">
          {!open && (
            <div class="bg-success/10 border-success rounded-box border p-6 text-center">
              <p class="text-base-content/70 text-sm">
                {session.name
                  ? `The ${session.name} train is eating at`
                  : "Today we're eating at"}
              </p>
              <p class="text-3xl font-bold">
                {chosen ? (
                  <a href={`/places/${chosen.slug}`} class="hover:link">
                    {chosen.name}
                  </a>
                ) : (
                  placeName(session.chosen_place_id)
                )}
              </p>
              {canManage && (
                <div class="mt-3 flex justify-center gap-2">
                  <button
                    class="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() =>
                      call(() =>
                        actions.lunch.reopen({ trainId: session.public_id }),
                      )
                    }
                  >
                    Reopen
                  </button>
                  {session.name && (
                    <button
                      class="btn btn-ghost btn-sm text-error"
                      disabled={busy}
                      onClick={onDelete}
                    >
                      Delete train
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {open && session.mode === "democracy" && (
            <div>
              <h2 class="mb-2 text-sm font-semibold uppercase opacity-60">
                Vote for a place
              </h2>
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
                              ? actions.lunch.unvote({
                                  trainId: session.public_id,
                                })
                              : actions.lunch.vote({
                                  trainId: session.public_id,
                                  placeId: place.id,
                                }),
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
                          <span class="badge badge-neutral">
                            {v?.count ?? 0}
                          </span>
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
          )}

          {open && session.mode === "dictatorship" && (
            <div>
              <h2 class="text-lg font-semibold">
                👑 {session.dictator_name ?? "No dictator designated yet"}
              </h2>
              {isDictator ? (
                <>
                  <p class="text-base-content/70 mb-2 text-sm">
                    You are this train's dictator. Choose wisely — everyone eats
                    where you say.
                  </p>
                  <ul class="flex flex-col gap-2">
                    {activePlaces.map((place) => (
                      <li key={place.id}>
                        <button
                          class="btn btn-ghost bg-base-200 w-full justify-start"
                          disabled={busy}
                          onClick={() =>
                            call(() =>
                              actions.lunch.dictatorPick({
                                trainId: session.public_id,
                                placeId: place.id,
                              }),
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
                    : "The train's manager needs to designate a dictator."}
                </p>
              )}
            </div>
          )}

          {open && session.mode === "random" && (
            <div class="py-4 text-center">
              <span class="text-4xl">🎲</span>
              <p class="text-base-content/70">
                Fate decides today. {activePlaces.length} places in the draw —
                {canManage
                  ? " hit Decide when everyone's in."
                  : " the train's manager rolls the dice when everyone's in."}
              </p>
            </div>
          )}

          <div>
            <h2 class="text-sm font-semibold uppercase opacity-60">
              Who's in ({participants.length})
            </h2>
            {participants.length === 0 ? (
              <p class="text-base-content/60 text-sm">
                Nobody yet. Be the first!
              </p>
            ) : (
              <div class="mt-1 flex flex-wrap gap-1">
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

          {canManage && open && (
            <div class="border-warning rounded-box border p-3">
              <h2 class="mb-2 text-sm font-semibold uppercase opacity-60">
                Train controls
              </h2>
              <div class="flex flex-wrap items-center gap-2">
                <select
                  class="select select-bordered select-sm"
                  disabled={busy}
                  value={session.mode}
                  onChange={(e) =>
                    call(() =>
                      actions.lunch.setMode({
                        trainId: session.public_id,
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
                        call(() =>
                          actions.lunch.setDictator({
                            trainId: session.public_id,
                            name,
                          }),
                        );
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
                    onClick={() =>
                      call(() =>
                        actions.lunch.finalize({ trainId: session.public_id }),
                      )
                    }
                  >
                    {session.mode === "random" ? "🎲 Decide" : "Finalize"}
                  </button>
                )}
                {session.name && (
                  <button
                    class="btn btn-ghost btn-sm text-error ml-auto"
                    disabled={busy}
                    onClick={onDelete}
                  >
                    Delete train
                  </button>
                )}
              </div>
            </div>
          )}

          <a
            href={`/sessions/${session.public_id}`}
            class="text-base-content/50 hover:link self-end text-xs"
            title="Permalink to this session"
          >
            #{session.public_id}
          </a>
        </div>
      </div>
    </section>
  );
}
