const express = require('express');
const fs = require('fs');
const path = require('path');
const { WebcastPushConnection } = require('tiktok-live-connector');

const PORT = process.env.PORT || 8080;
const USERNAME = process.env.TIKTOK_USERNAME; // tu @usuario, SIN el @, ej: midiendausuario
const ESTADO_FILE = path.join(__dirname, 'estado.json');

if (!USERNAME) {
  console.error('Falta la variable de entorno TIKTOK_USERNAME');
  process.exit(1);
}

const EQUIPOS = [
  "Colo Colo","River Plate","Boca Juniors","Flamengo","Palmeiras",
  "Peñarol","Nacional","Racing","Independiente","Universitario",
  "Alianza Lima","Barcelona SC","LDU Quito","Emelec","Cerro Porteño",
  "Olimpia","Bolívar","The Strongest","Deportivo Táchira","Junior"
];

const DURACION_RONDA = 5 * 60;
const DURACION_DESEMPATE = 10;

function estadoInicial() {
  const scores = {};
  EQUIPOS.forEach(e => scores[e] = 0);
  return {
    scores,
    historial: {},
    logs: [],
    fase: 'regular',
    equiposDesempate: [],
    tiempoRestante: DURACION_RONDA,
    liderActual: null,
    conectado: false
  };
}

function cargarEstado() {
  try {
    const raw = fs.readFileSync(ESTADO_FILE, 'utf8');
    const data = JSON.parse(raw);
    EQUIPOS.forEach(e => { if (!(e in data.scores)) data.scores[e] = 0; });
    data.conectado = false;
    return data;
  } catch (e) {
    return estadoInicial();
  }
}

function guardarEstado() {
  fs.writeFileSync(ESTADO_FILE, JSON.stringify(estado));
}

let estado = cargarEstado();

function normalizar(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function buscarEquipo(texto) {
  const t = normalizar(texto);
  if (!t) return null;
  let match = EQUIPOS.find(e => normalizar(e) === t);
  if (match) return match;
  match = EQUIPOS.find(e => t.includes(normalizar(e)));
  return match || null;
}

function ordinalGanada(n) {
  if (n === 1) return 'gana la primera';
  return 'gana la ' + n + 'ª';
}

function agregarLog(msg, tipo) {
  estado.logs.push({ msg, tipo, t: Date.now() });
  estado.logs = estado.logs.slice(-80);
}

function sumarPunto(equipo) {
  if (estado.fase === 'desempate' && !estado.equiposDesempate.includes(equipo)) return;
  estado.scores[equipo] = (estado.scores[equipo] || 0) + 1;
  agregarLog(`${equipo} suma un punto · ahora tiene ${estado.scores[equipo]}`, 'gol');
}

function tabla(activos) {
  const ordenado = [...activos].sort((a, b) => estado.scores[b] - estado.scores[a]);
  const maxPts = ordenado.length ? estado.scores[ordenado[0]] : 0;
  const empatadosArriba = ordenado.filter(e => estado.scores[e] === maxPts).length;
  return { ordenado, maxPts, empatadosArriba };
}

function coronarCampeon(equipo) {
  estado.historial[equipo] = (estado.historial[equipo] || 0) + 1;
  const veces = estado.historial[equipo];
  agregarLog(`🏆 ${equipo} ${ordinalGanada(veces)} de la liga`, 'campeon');

  const scores = {};
  EQUIPOS.forEach(e => scores[e] = 0);
  estado.scores = scores;
  estado.fase = 'regular';
  estado.equiposDesempate = [];
  estado.liderActual = null;
  estado.tiempoRestante = DURACION_RONDA;
}

function finalizarPeriodo() {
  const activos = estado.fase === 'desempate' ? estado.equiposDesempate : EQUIPOS;
  const { ordenado, maxPts, empatadosArriba } = tabla(activos);

  if (estado.fase === 'regular') {
    if (empatadosArriba >= 2) {
      estado.equiposDesempate = ordenado.filter(e => estado.scores[e] === maxPts);
      estado.equiposDesempate.forEach(e => estado.scores[e] = 0);
      estado.fase = 'desempate';
      estado.tiempoRestante = DURACION_DESEMPATE;
      agregarLog(`Empate en ${maxPts} puntos entre ${estado.equiposDesempate.join(' y ')} — arranca el desempate de 10 segundos`, 'gol');
    } else {
      coronarCampeon(ordenado[0]);
    }
  } else {
    const ordenDesempate = [...estado.equiposDesempate].sort((a, b) => estado.scores[b] - estado.scores[a]);
    const topPts = estado.scores[ordenDesempate[0]];
    const empatados = ordenDesempate.filter(e => estado.scores[e] === topPts);
    if (empatados.length >= 2) {
      estado.equiposDesempate = empatados;
      estado.equiposDesempate.forEach(e => estado.scores[e] = 0);
      estado.tiempoRestante = DURACION_DESEMPATE;
      agregarLog(`Sigue el empate entre ${empatados.join(' y ')} — se repite el desempate`, 'gol');
    } else {
      coronarCampeon(ordenDesempate[0]);
    }
  }
}

// reloj de la liga: solo corre mientras hay live conectado
setInterval(() => {
  if (!estado.conectado) return;
  estado.tiempoRestante--;
  if (estado.tiempoRestante <= 0) {
    finalizarPeriodo();
  }
  guardarEstado();
}, 1000);

// conexión a TikTok Live, con reintentos automáticos
let conn = null;

function conectar() {
  conn = new WebcastPushConnection(USERNAME);

  conn.connect()
    .then(state => {
      console.log('Conectado al live de TikTok, room id:', state.roomId);
      estado.conectado = true;
      agregarLog('Conectado al live de TikTok', 'gol');
    })
    .catch(err => {
      console.error('No se pudo conectar (¿estás en vivo ahora?):', err.message || err);
      estado.conectado = false;
      setTimeout(conectar, 15000); // reintenta en 15s
    });

  conn.on('chat', data => {
    const texto = data.comment;
    if (!texto) return;
    const equipo = buscarEquipo(texto);
    if (equipo) sumarPunto(equipo);
  });

  conn.on('disconnected', () => {
    console.log('Se cortó la conexión con el live, reintentando...');
    estado.conectado = false;
    setTimeout(conectar, 15000);
  });

  conn.on('streamEnd', () => {
    console.log('El live terminó');
    estado.conectado = false;
    setTimeout(conectar, 15000);
  });
}

conectar();

// servidor web: expone el estado y sirve la página
const app = express();
app.use(express.static(__dirname));

app.get('/api/estado', (req, res) => {
  res.json(estado);
});

app.listen(PORT, () => {
  console.log(`Liga infinita (TikTok) corriendo en el puerto ${PORT}`);
});
