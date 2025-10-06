import React, { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

/**
 * Reserva Deportiva UAI – WebApp (RFID-ready)
 * -------------------------------------------------------------------------
 * Objetivo
 *  - Frontend listo para conectar a una BD/API (aún no construida) que permita:
 *    1) Listar clases deportivas (futbol, voley, escalada, gimnasio, etc.)
 *    2) Reservar en bloques entre 07:00 y 18:00 (configurable)
 *    3) Calcular ventana de acceso: [inicio - 10min, fin + 10min]
 *    4) Generar “payload RFID” para que el ESP8266 lo grabe en la tarjeta
 *    5) Modo Mock automático si la API no está lista (usa localStorage)
 *
 * Cómo conectar a la API cuando esté lista (contratos sugeridos):
 *  - GET  /api/classes
 *      → [{ id: "gim", name: "Gimnasio", durationMinutes: 60 }, ...]
 *  - GET  /api/reservations?studentId=UAI123&date=2025-10-03
 *      → [{ id, studentId, classId, startISO, endISO }]
 *  - POST /api/reservations
 *      body: { studentId, classId, startISO, endISO }
 *      → 201 { id, ... }
 *  - (Opcional) GET /api/reservations/access?cardId=XXXX&now=ISO
 *      → { allowed: true|false, reason: "inside_window|no_reservation|wrong_time" }
 *
 * Notas técnicas
 *  - Zona horaria: usa la del navegador. Para UAI: America/Santiago.
 *  - Time slots: por defecto cada 30 min entre 07:00–18:00.
 *  - Duración de clase: se toma de la clase (p.ej., 60 min); editable manualmente si se desea.
 *  - Ventana de acceso = inicio - GRACE_MIN antes, fin + GRACE_MIN después (10 min por defecto).
 *  - RFID payload: string compacto y versión hex. El ESP8266 puede recibirlo por serie o HTTP.
 */

// ============================ CONFIG ============================
const API_BASE = ""; // si usan proxy, ej: "/"; si es backend en otro host: "https://tu-api.com"
const USE_MOCK_FALLBACK = true; // usa localStorage si la API falla
const DAY_START = 7; // 07:00
const DAY_END = 18; // 18:00
const SLOT_MINUTES = 30; // tamaño del bloque
const GRACE_MIN = 10; // minutos antes/después

// Lista de clases por defecto (si no hay API)
const DEFAULT_CLASSES = [
  { id: "fut", name: "Fútbol", durationMinutes: 60 },
  { id: "voley", name: "Vóleibol", durationMinutes: 60 },
  { id: "esc", name: "Escalada", durationMinutes: 90 },
  { id: "gim", name: "Gimnasio", durationMinutes: 60 },
];

// ============================ HELPERS ============================
function pad(n) { return n.toString().padStart(2, "0"); }

function toLocalISO(date) {
  // Devuelve YYYY-MM-DDTHH:mm:ss.sssZ ajustado correctamente a UTC
  return new Date(date).toISOString();
}

function combineDateTime(dateStr, timeStr) {
  // dateStr: "YYYY-MM-DD", timeStr: "HH:MM"
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
  return dt;
}

function minutesAdd(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd; // true si hay intersección
}

function formatHuman(dt) {
  return dt.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function toEpochSeconds(dt) {
  return Math.floor(dt.getTime() / 1000);
}

function buildRfidPayload({ studentId, classId, startISO, endISO }) {
  // Formato compacto legible + checksum sencillo
  const startEpoch = Math.floor(new Date(startISO).getTime() / 1000);
  const endEpoch = Math.floor(new Date(endISO).getTime() / 1000);
  const raw = `UAI|${studentId}|${classId}|${startEpoch}|${endEpoch}`; // <= ~40-60 bytes
  let checksum = 0;
  for (let i = 0; i < raw.length; i++) checksum = (checksum + raw.charCodeAt(i)) % 256;
  const framed = `${raw}|CS${pad(checksum)}`;
  // versión hex (por si quieren grabar como bytes puros)
  const hex = Array.from(new TextEncoder().encode(framed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { text: framed, hex };
}

async function safeFetch(url, opts) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (!USE_MOCK_FALLBACK) throw e;
    return null; // el caller decide mockear
  }
}

// ============================ MOCK STORAGE ============================
const mock = {
  loadClasses: async () => DEFAULT_CLASSES,
  loadReservations: async (studentId, dateStr) => {
    const all = JSON.parse(localStorage.getItem("mock_reservations") || "[]");
    return all.filter((r) => r.studentId === studentId && r.startISO.startsWith(dateStr));
  },
  createReservation: async (payload) => {
    const all = JSON.parse(localStorage.getItem("mock_reservations") || "[]");
    const id = "rsv_" + Math.random().toString(36).slice(2, 9);
    const rec = { id, ...payload };
    all.push(rec);
    localStorage.setItem("mock_reservations", JSON.stringify(all));
    return rec;
  },
};

// ============================ UI ============================
export default function App() {
  const [studentId, setStudentId] = useState("");
  const [classes, setClasses] = useState([]);
  const [selectedClass, setSelectedClass] = useState("");
  const [dateStr, setDateStr] = useState(() => new Date().toISOString().slice(0, 10));
  const [timeStr, setTimeStr] = useState("07:00");
  const [customDuration, setCustomDuration] = useState(""); // opcional
  const [reservations, setReservations] = useState([]);
  const [statusMsg, setStatusMsg] = useState("");
  const [creating, setCreating] = useState(false);
  const [rfid, setRfid] = useState(null);

  // Cargar clases
  useEffect(() => {
    (async () => {
      const api = await safeFetch(`${API_BASE}/api/classes`);
      if (api && Array.isArray(api)) setClasses(api);
      else setClasses(DEFAULT_CLASSES);
    })();
  }, []);

  // Cargar reservas del alumno para el día
  useEffect(() => {
    if (!studentId) { setReservations([]); return; }
    (async () => {
      const url = `${API_BASE}/api/reservations?studentId=${encodeURIComponent(studentId)}&date=${dateStr}`;
      const data = await safeFetch(url);
      if (data) setReservations(data);
      else setReservations(await mock.loadReservations(studentId, dateStr));
    })();
  }, [studentId, dateStr]);

  const timeSlots = useMemo(() => {
    const slots = [];
    for (let h = DAY_START; h <= DAY_END; h++) {
      for (let m = 0; m < 60; m += SLOT_MINUTES) {
        const label = `${pad(h)}:${pad(m)}`;
        if (h === DAY_END && m > 0) continue; // no pasar de las 18:00 como inicio
        slots.push(label);
      }
    }
    return slots;
  }, []);

  const currentClass = classes.find((c) => c.id === selectedClass);
  const duration = Number(customDuration) || currentClass?.durationMinutes || 60;

  const startDT = useMemo(() => combineDateTime(dateStr, timeStr), [dateStr, timeStr]);
  const endDT = useMemo(() => minutesAdd(startDT, duration), [startDT, duration]);
  const windowStart = useMemo(() => minutesAdd(startDT, -GRACE_MIN), [startDT]);
  const windowEnd = useMemo(() => minutesAdd(endDT, GRACE_MIN), [endDT]);

  const overlapExists = useMemo(() => {
    return reservations.some((r) => {
      const aS = new Date(r.startISO);
      const aE = new Date(r.endISO);
      return overlaps(aS, aE, startDT, endDT);
    });
  }, [reservations, startDT, endDT]);

  async function createReservation() {
    setStatusMsg("");
    setRfid(null);
    if (!studentId || !selectedClass) {
      setStatusMsg("Completa tu ID y la clase.");
      return;
    }
    if (overlapExists) {
      setStatusMsg("Ya tienes una reserva que se superpone en ese horario.");
      return;
    }
    setCreating(true);
    const payload = {
      studentId,
      classId: selectedClass,
      startISO: toLocalISO(startDT),
      endISO: toLocalISO(endDT),
    };

    // Intento API real
    const created = await safeFetch(`${API_BASE}/api/reservations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let rec = created;
    if (!rec) {
      // Mock local
      rec = await mock.createReservation(payload);
    }

    setStatusMsg("Reserva creada correctamente.");
    setReservations((prev) => [...prev, rec]);

    // Construimos payload RFID para programar la tarjeta
    const p = buildRfidPayload(payload);
    setRfid(p);
    setCreating(false);
  }

  function checkAccessNow() {
    const now = new Date();
    const allowed = now >= windowStart && now <= windowEnd;
    setStatusMsg(
      allowed
        ? "ACCESO PERMITIDO ahora (ventana activa)."
        : "Acceso NO permitido en este momento."
    );
  }
  const SHOW_RFID = false; // oculta la sección del payload RFID

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 text-slate-900">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/70 border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Reservas Deportivas UAI · RFID</h1>
        
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 grid md:grid-cols-3 gap-6">
        {/* Panel de reserva */}
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="md:col-span-2 bg-white rounded-2xl shadow p-5 space-y-4"
        >
          <h2 className="text-lg font-semibold">Nueva reserva</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">ID Alumno (RUT / correo)</label>
              <input
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
                placeholder="uai123456 / nombre@uai.cl"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Clase</label>
              <select
                value={selectedClass}
                onChange={(e) => setSelectedClass(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                <option value="" disabled>Selecciona una clase…</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} · {c.durationMinutes} min</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Fecha</label>
              <input
                type="date"
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Hora de inicio</label>
              <select
                value={timeStr}
                onChange={(e) => setTimeStr(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                {timeSlots.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Duración (min) — opcional</label>
              <input
                type="number"
                min={15}
                step={15}
                value={customDuration}
                onChange={(e) => setCustomDuration(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
                placeholder={`${duration}`}
              />
              <p className="text-xs text-slate-500 mt-1">Por defecto usa la duración de la clase.</p>
            </div>
            <div>
              <label className="text-sm font-medium">Ventana de acceso (±{GRACE_MIN} min)</label>
              <div className="mt-1 p-3 rounded-xl bg-slate-50 border border-slate-200 text-sm">
                <div><b>Inicio:</b> {formatHuman(startDT)}</div>
                <div><b>Fin:</b> {formatHuman(endDT)}</div>
                <div className="mt-1 text-slate-500">Acceso válido entre <b>{formatHuman(windowStart)}</b> y <b>{formatHuman(windowEnd)}</b>.</div>
              </div>
            </div>
          </div>

          {overlapExists && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 text-amber-800 p-3 text-sm">
              Ya tienes una reserva que se superpone con ese horario.
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={createReservation}
              disabled={creating}
              className="px-4 py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {creating ? "Creando…" : "Crear reserva"}
            </button>
            <button
              onClick={checkAccessNow}
              className="px-4 py-2 rounded-xl border border-slate-300 hover:bg-slate-50"
            >
              ¿Tengo acceso ahora?
            </button>
          </div>

          {!!statusMsg && (
            <div
              className={
                "rounded-xl p-3 text-sm " +
                (statusMsg.includes("NO")
                  ? "bg-rose-50 border border-rose-200 text-rose-700"
                  : statusMsg.includes("PERMITIDO")
                  ? "bg-green-50 border border-green-200 text-green-700"
                  : "bg-slate-50 border border-slate-200 text-slate-700")
              }
            >
              {statusMsg}
            </div>
          )}

          {SHOW_RFID && rfid && (
            <div className="mt-2 space-y-2">
              <h3 className="font-semibold">Payload para grabar en tarjeta RFID</h3>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm break-all">
                <div><b>Texto:</b> {rfid.text}</div>
                <div className="mt-1"><b>Hex:</b> {rfid.hex}</div>
              </div>
              <p className="text-xs text-slate-500">El ESP8266 puede validar <i>now</i> ∈ [start−{GRACE_MIN}min, end+{GRACE_MIN}min] usando estos epoch.</p>
            </div>
          )}
        </motion.section>

        {/* Panel lateral: reservas del día y guía de API */}
        <motion.aside
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="bg-white rounded-2xl shadow p-5 space-y-4"
        >
          <h3 className="text-lg font-semibold">Tus reservas para el día</h3>
          {!studentId ? (
            <p className="text-sm text-slate-500">Ingresa tu ID para ver tus reservas.</p>
          ) : reservations.length === 0 ? (
            <p className="text-sm text-slate-500">No hay reservas para {dateStr}.</p>
          ) : (
            <ul className="space-y-2">
              {reservations.map((r) => {
                const s = new Date(r.startISO);
                const e = new Date(r.endISO);
                const wS = minutesAdd(s, -GRACE_MIN);
                const wE = minutesAdd(e, GRACE_MIN);
                return (
                  <li key={r.id} className="border border-slate-200 rounded-xl p-3">
                    <div className="text-sm"><b>Clase:</b> {classes.find((c) => c.id === r.classId)?.name || r.classId}</div>
                    <div className="text-sm"><b>Inicio:</b> {formatHuman(s)}</div>
                    <div className="text-sm"><b>Fin:</b> {formatHuman(e)}</div>
                    <div className="text-xs text-slate-500">Ventana: {formatHuman(wS)} → {formatHuman(wE)}</div>
                  </li>
                );
              })}
            </ul>
          )}

         

        </motion.aside>
      </main>

      <footer className="max-w-5xl mx-auto px-4 pb-8 text-xs text-slate-500">
        <div className="mt-6">© {new Date().getFullYear()} UAI · Prototipo de reserva con ventana de acceso RFID.</div>
      </footer>
    </div>
  );
}
