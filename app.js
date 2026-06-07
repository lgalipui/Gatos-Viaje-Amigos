/**
 * Gatos Viaje Amigos - Gestor de Gastos y Cuentas de Viaje
 * Lógica principal de la aplicación.
 */

// Cargar tema guardado antes de que cargue el DOM para evitar parpadeos
(function() {
    const savedTheme = localStorage.getItem("gatos_theme") || "dark";
    if (savedTheme === "light") {
        document.body.classList.add("light-theme");
    }
})();

// ==========================================================================
// ESTADO GLOBAL DE LA APLICACIÓN
// ==========================================================================
let expenses = []; // Lista de gastos { id, description, amount, date, payer, participants, isManual }
let members = new Set(); // Conjunto de nombres de participantes únicos
let dataSource = "demo"; // "demo" | "file" | "pasted" | "local"
let completedSettlements = new Set(); // Conjunto de claves de liquidaciones realizadas "from_to_amount"

// Datos demo predefinidos en caso de que Cuentas.txt esté vacío o falte
const DEMO_CHAT = `[01/06/2026 14:32:10] Alejandro: Buenas! Ya listos para el viaje?
[01/06/2026 14:35:15] Bea: Sí! Qué ganas. Nos vemos en el aeropuerto.
[01/06/2026 18:12:00] Carlos: He pagado la fianza del coche de alquiler: 150€
[01/06/2026 21:30:22] David: Cena de hoy en el puerto: 85.50 eur
[02/06/2026 09:15:00] Elena: Desayunos en la cafetería: 22.40€
[02/06/2026 13:45:12] Alejandro: Gasolina coche 1: 52 eur
[02/06/2026 17:30:45] Bea: Compra super: 64.80 euros para las cenas
[03/06/2026 11:20:10] Carlos: Entradas museo: 45 €
[03/06/2026 14:50:35] David: Autopista peaje: 12.80€
[03/06/2026 16:00:00] Alejandro: Chicos, ¿quién tiene las llaves?
[03/06/2026 16:02:11] Elena: Las tengo yo!
[03/06/2026 22:10:00] Elena: Yo pagué las cervezas de la terraza: 35€
[04/06/2026 10:00:00] Alejandro: Parking del hotel: 18€`;

// ==========================================================================
// INICIALIZACIÓN
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
    initTheme(); // Inicializa el tema día/noche
    initApp();
    setupEventListeners();
});

/**
 * Inicializa la aplicación cargando desde LocalStorage o Cuentas.txt
 */
async function initApp() {
    const localExpenses = localStorage.getItem("gatos_expenses");
    const localMembers = localStorage.getItem("gatos_members");
    const localSource = localStorage.getItem("gatos_source");
    const localCompleted = localStorage.getItem("gatos_completed_settlements");

    if (localCompleted) {
        try {
            completedSettlements = new Set(JSON.parse(localCompleted));
        } catch (e) {
            console.error("Error al leer completedSettlements de localStorage", e);
        }
    }

    if (localExpenses && localMembers) {
        try {
            expenses = JSON.parse(localExpenses);
            members = new Set(JSON.parse(localMembers));
            dataSource = localSource || "local";
            showToast("Datos recuperados del almacenamiento local");
            updateAppUI();
        } catch (e) {
            console.error("Error al leer de localStorage. Recargando...", e);
            await fetchChatFile();
        }
    } else {
        await fetchChatFile();
    }

    // Comprobar si hay un viaje compartido en el hash de la URL
    checkUrlHashTrip();
}

/**
 * Intenta hacer fetch del archivo Cuentas.txt en el directorio raíz
 */
async function fetchChatFile() {
    updateBannerStatus("loading", "Cargando archivo Cuentas.txt...");
    try {
        const response = await fetch("Cuentas.txt");
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        if (text && text.trim().length > 0) {
            processChatText(text, "file");
            showToast("Datos cargados correctamente de Cuentas.txt");
        } else {
            // El archivo está vacío, cargar demo
            console.log("Cuentas.txt está vacío. Cargando chat demo.");
            processChatText(DEMO_CHAT, "demo");
            showToast("Cuentas.txt vacío. Mostrando datos de ejemplo.");
        }
    } catch (err) {
        console.warn("No se pudo cargar Cuentas.txt. Cargando chat de demostración.", err);
        processChatText(DEMO_CHAT, "demo");
        showToast("No se encontró Cuentas.txt. Cargando datos de ejemplo.");
    }
}

// ==========================================================================
// LÓGICA DE DETECCIÓN Y PARSING
// ==========================================================================

/**
 * Procesa el texto plano del chat y actualiza el estado global
 */
function processChatText(text, source) {
    const messages = parseWhatsAppMessages(text);
    
    // Primero, recolectamos todos los participantes únicos del chat
    const detectedMembers = new Set();
    messages.forEach(msg => {
        if (msg.sender) detectedMembers.add(msg.sender);
    });

    // Si no detectamos participantes válidos, no podemos hacer mucho
    if (detectedMembers.size === 0) {
        showToast("No se detectaron remitentes en el formato correcto", "danger");
        return;
    }

    members = detectedMembers;
    dataSource = source;
    expenses = [];
    completedSettlements.clear();

    // Analizamos cada mensaje buscando gastos
    messages.forEach((msg, idx) => {
        const detected = detectExpense(msg.text);
        if (detected) {
            expenses.push({
                id: `parsed-${idx}-${Date.now()}`,
                description: detected.description,
                amount: detected.amount,
                date: msg.dateISO || new Date().toISOString().split("T")[0],
                payer: msg.sender,
                participants: Array.from(members), // Por defecto se divide entre todos
                isManual: false
            });
        }
    });

    saveToLocalStorage();
    updateAppUI();
}

/**
 * Parsea el texto del chat de WhatsApp a una lista de objetos de mensaje
 * Soporta formatos típicos de iOS y Android en español/inglés
 */
function parseWhatsAppMessages(text) {
    const lines = text.split(/\r?\n/);
    const messages = [];
    let currentMessage = null;

    // Regex robusta para cabeceras de mensaje de WhatsApp:
    // 1. iOS: [dd/mm/aaaa hh:mm:ss] Emisor: Mensaje...
    // 2. Android: dd/mm/aaaa, hh:mm - Emisor: Mensaje...
    // 3. Android simple: dd/mm/aa hh:mm - Emisor: Mensaje...
    // Captura: Grupo 1 = Fecha completa, Grupo 2 = Hora, Grupo 3 = Emisor, Grupo 4 = Texto inicial
    const headerRegex = /^\[?(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})(?:,?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM|a\.\s*m\.|p\.\s*m\.))?))?\]?\s*(?:-\s*|:\s*)?([^:]+):\s*(.*)$/i;

    lines.forEach(line => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        const match = trimmedLine.match(headerRegex);
        if (match) {
            // Guardamos el mensaje anterior si existía
            if (currentMessage) {
                messages.push(currentMessage);
            }
            
            const rawDate = match[1];
            const rawTime = match[2] || "12:00";
            const sender = match[3].trim();
            const textContent = match[4].trim();

            // Intentar formatear la fecha a ISO (AAAA-MM-DD)
            let dateISO = null;
            try {
                // Soportar formatos de fecha dd/mm/aaaa o dd/mm/aa
                const parts = rawDate.split(/[/\-.]/);
                if (parts.length === 3) {
                    let day = parseInt(parts[0], 10);
                    let month = parseInt(parts[1], 10) - 1; // 0-indexed en JS
                    let year = parseInt(parts[2], 10);
                    if (year < 100) {
                        year += year < 70 ? 2000 : 1900; // Ajuste básico año corto
                    }
                    const dObj = new Date(year, month, day);
                    if (!isNaN(dObj.getTime())) {
                        // Formato YYYY-MM-DD local
                        dateISO = `${dObj.getFullYear()}-${String(dObj.getMonth() + 1).padStart(2, '0')}-${String(dObj.getDate()).padStart(2, '0')}`;
                    }
                }
            } catch (err) {
                console.error("Error parseando fecha", rawDate, err);
            }

            // Ignorar mensajes del sistema tipo "Los mensajes están cifrados..." o "Creado por..."
            // Si el nombre del emisor es muy largo o contiene palabras del sistema, ignorar
            if (sender.toLowerCase().includes("whatsapp") || sender.length > 25) {
                currentMessage = null;
                return;
            }

            currentMessage = {
                date: rawDate,
                time: rawTime,
                dateISO: dateISO,
                sender: sender,
                text: textContent
            };
        } else {
            // Es una línea de continuación del mensaje anterior
            if (currentMessage) {
                currentMessage.text += " " + trimmedLine;
            }
        }
    });

    // Añadir el último mensaje procesado
    if (currentMessage) {
        messages.push(currentMessage);
    }

    return messages;
}

/**
 * Analiza el texto de un mensaje para detectar si contiene un gasto
 * Devuelve { amount, description } o null
 */
function detectExpense(text) {
    if (!text) return null;

    // Expresión Regular para cantidad de dinero (soporta coma o punto decimal)
    // 1. Patrón con divisa al final: e.g. "45.20€", "45 eur", "15 euros", "30 $"
    const currencyAfterRegex = /(?:^|\s)(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur|euros|usd|\$|£|pesos)(?:\b|\s|$)/i;
    // 2. Patrón con divisa al inicio: e.g. "€45.20", "$ 15", "EUR 30"
    const currencyBeforeRegex = /(?:^|\s)(?:€|eur|euros|usd|\$|£)\s*(\d+(?:[.,]\d{1,2})?)(?:\b|\s|$)/i;

    let amount = null;
    let matchedString = "";

    // Probar patrón 1
    let match = text.match(currencyAfterRegex);
    if (match) {
        amount = parseFloat(match[1].replace(",", "."));
        matchedString = match[0];
    } else {
        // Probar patrón 2
        match = text.match(currencyBeforeRegex);
        if (match) {
            amount = parseFloat(match[1].replace(",", "."));
            matchedString = match[0];
        }
    }

    // Patrón 3: Si no tiene símbolo de moneda explícito, pero sí un número
    // y palabras clave que denoten gasto (ej: "he pagado 15 en el taxi", "gasolina 34")
    if (amount === null) {
        const rawNumberRegex = /(?:^|\s)(\d+(?:[.,]\d{1,2})?)(?:\b|\s|$)/;
        const expenseKeywords = [
            "pague", "pagué", "gasto", "gasté", "compra", "súper", "super", 
            "comida", "cena", "gasolina", "peaje", "parking", "alojamiento", 
            "hotel", "viaje", "entradas", "cervezas", "taxi", "uber", "bus", 
            "tren", "cuentas", "total", "fianza", "entradas", "tickets"
        ];
        
        const lowercaseText = text.toLowerCase();
        const hasKeyword = expenseKeywords.some(kw => lowercaseText.includes(kw));
        
        match = text.match(rawNumberRegex);
        if (match && hasKeyword) {
            // Asegurarnos de que no es una hora (ej. "a las 15" o "15:30")
            const isTimeContext = /a\s+las\s+\d+|:\d+/.test(lowercaseText);
            if (!isTimeContext) {
                amount = parseFloat(match[1].replace(",", "."));
                matchedString = match[0];
            }
        }
    }

    if (amount !== null && !isNaN(amount) && amount > 0) {
        // Limpiamos la descripción quitando el texto que representaba la cantidad monetaria
        let description = text.replace(matchedString, "").trim();
        
        // Limpieza cosmética de caracteres sobrantes
        description = description.replace(/^[-\s:;]+/, "").trim(); // Quita guiones o puntos iniciales
        description = description.replace(/[-\s:;]+$/, "").trim(); // Quita guiones o dos puntos finales
        
        // Si la descripción se queda vacía, ponemos un genérico
        if (!description) {
            description = "Gasto del viaje";
        }

        // Capitalizar la primera letra
        description = description.charAt(0).toUpperCase() + description.slice(1);

        return {
            amount: Math.round(amount * 100) / 100,
            description: description
        };
    }

    return null;
}

// ==========================================================================
// ALGORITMO DE SIMPLIFICACIÓN DE DEUDAS (SOLVER)
// ==========================================================================

/**
 * Calcula el saldo de cada miembro y genera la lista simplificada de pagos
 */
function solveDebts() {
    const balances = {};
    
    // Inicializar el saldo de todos los miembros en 0
    members.forEach(member => {
        balances[member] = 0;
    });

    // Calcular la diferencia neta: Pagado - Debe
    expenses.forEach(exp => {
        const amount = exp.amount;
        const payer = exp.payer;
        const participants = exp.participants || [];

        if (participants.length === 0) return;

        // Sumar al pagador la cantidad total
        if (balances[payer] !== undefined) {
            balances[payer] += amount;
        }

        // Restar a cada participante su parte proporcional
        const share = amount / participants.length;
        participants.forEach(participant => {
            if (balances[participant] !== undefined) {
                balances[participant] -= share;
            }
        });
    });

    // Clasificar miembros en deudores (saldo < 0) y acreedores (saldo > 0)
    const debtors = [];
    const creditors = [];

    Object.keys(balances).forEach(person => {
        const bal = balances[person];
        // Toleramos pequeños errores de redondeo de punto flotante (< 0.01)
        if (bal < -0.019) {
            debtors.push({ name: person, balance: bal });
        } else if (bal > 0.019) {
            creditors.push({ name: person, balance: bal });
        }
    });

    // Ordenar: deudores de mayor deuda a menor, acreedores de mayor crédito a menor
    debtors.sort((a, b) => a.balance - b.balance); // más negativo primero
    creditors.sort((a, b) => b.balance - a.balance); // más positivo primero

    const transactions = [];
    let dIdx = 0;
    let cIdx = 0;

    // Copias de trabajo de deudores y acreedores
    const tempDebtors = debtors.map(x => ({ ...x }));
    const tempCreditors = creditors.map(x => ({ ...x }));

    while (dIdx < tempDebtors.length && cIdx < tempCreditors.length) {
        const debtor = tempDebtors[dIdx];
        const creditor = tempCreditors[cIdx];

        const amountToPay = -debtor.balance;
        const amountToReceive = creditor.balance;

        // La transferencia es el mínimo entre lo que debe pagar uno y lo que debe recibir el otro
        const transfer = Math.min(amountToPay, amountToReceive);
        
        if (transfer > 0.01) {
            transactions.push({
                from: debtor.name,
                to: creditor.name,
                amount: Math.round(transfer * 100) / 100
            });
        }

        // Ajustar balances
        debtor.balance += transfer;
        creditor.balance -= transfer;

        // Avanzar punteros si se han saldado
        if (Math.abs(debtor.balance) < 0.01) dIdx++;
        if (Math.abs(creditor.balance) < 0.01) cIdx++;
    }

    return {
        balances: balances,
        transactions: transactions
    };
}

// ==========================================================================
// RENDERIZADO DE LA INTERFAZ DE USUARIO (DOM)
// ==========================================================================

/**
 * Actualiza todos los componentes de la interfaz de usuario con los datos actuales
 */
/**
 * Actualiza todos los componentes de la interfaz de usuario con los datos actuales
 */
function updateAppUI() {
    const { balances, transactions } = solveDebts();
    
    // Habilitar o deshabilitar botón de añadir gasto según si hay miembros
    const addExpenseBtn = document.getElementById("btn-add-expense-manual");
    if (members.size === 0) {
        addExpenseBtn.disabled = true;
        addExpenseBtn.title = "Añade al menos un amigo antes de crear gastos";
    } else {
        addExpenseBtn.disabled = false;
        addExpenseBtn.title = "Añadir Gasto Manual";
    }

    // 1. Estadísticas Globales
    renderGlobalStats(balances);

    // 2. Banner de origen de datos
    updateDataSourceBanner();

    // 3. Tarjeta de lista de amigos (Amigos Tab)
    renderMembersList(balances);

    // 3b. Tarjeta de saldos y balances (Balances Tab)
    renderBalancesList(balances);
    renderBalancesChart(balances);

    // 4. Propuesta de pagos (Liquidación Tab)
    renderSettlementsList(transactions);

    // 5. Historial de gastos
    renderExpensesFeed();

    // 6. Actualizar dropdowns del modal y filtros
    updateFilterDropdowns();
}

/**
 * Renderiza los totales de la cabecera
 */
function renderGlobalStats(balances) {
    // Solo contar los gastos de viaje con terceros (excluyendo transferencias/pagos entre miembros)
    const realExpenses = expenses.filter(exp => !exp.isPayment);
    const totalSpent = realExpenses.reduce((sum, exp) => sum + exp.amount, 0);
    const memberCount = members.size;
    const avgSpent = memberCount > 0 ? totalSpent / memberCount : 0;

    document.getElementById("val-total-spent").textContent = `${totalSpent.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}€`;
    document.getElementById("val-avg-spent").textContent = `${avgSpent.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}€`;
    document.getElementById("val-active-members").textContent = `${memberCount} amigo${memberCount !== 1 ? 's' : ''} / ${realExpenses.length} gasto${realExpenses.length !== 1 ? 's' : ''}`;
}

/**
 * Actualiza el banner que indica de dónde vienen los datos
 */
function updateDataSourceBanner() {
    const dot = document.getElementById("data-status-dot");
    const text = document.getElementById("data-status-text");

    // Limpiar clases
    dot.className = "status-indicator pulsating ";

    switch (dataSource) {
        case "demo":
            dot.classList.add("warning");
            text.innerHTML = 'Mostrando <strong>datos de ejemplo</strong>. Usa "Cargar/Pegar Chat" para importar el tuyo.';
            break;
        case "file":
            dot.classList.add("success");
            text.innerHTML = 'Visualizando gastos del archivo <strong>Cuentas.txt</strong>.';
            break;
        case "pasted":
            dot.classList.add("success");
            text.innerHTML = "Visualizando gastos de <strong>chat copiado y pegado</strong>.";
            break;
        case "local":
            dot.classList.add("success");
            text.innerHTML = "Visualizando gastos guardados <strong>localmente</strong>.";
            break;
        default:
            dot.classList.add("danger");
            text.textContent = "Estado de datos desconocido.";
    }
}

/**
 * Dibuja la lista de amigos sin saldos (sólo amigos y total aportado)
 */
function renderMembersList(balances) {
    const container = document.getElementById("list-members");
    container.innerHTML = "";

    const sortedMembers = Array.from(members).sort();
    
    // Actualizar el contador del badge de amigos
    document.getElementById("badge-member-count").textContent = `${sortedMembers.length} amigo${sortedMembers.length !== 1 ? 's' : ''}`;
    
    if (sortedMembers.length === 0) {
        container.innerHTML = `
            <div class="empty-state-small">
                <p>No hay amigos agregados. Añade uno arriba.</p>
            </div>
        `;
        return;
    }
    
    // Contar cuánto ha pagado realmente cada persona (solo gastos reales a terceros)
    const paidByMember = {};
    members.forEach(m => paidByMember[m] = 0);
    expenses.forEach(exp => {
        if (!exp.isPayment && paidByMember[exp.payer] !== undefined) {
            paidByMember[exp.payer] += exp.amount;
        }
    });

    sortedMembers.forEach((member, idx) => {
        const paid = paidByMember[member] || 0;
        const initials = member.substring(0, 2).toUpperCase();

        const memberRow = document.createElement("div");
        memberRow.className = "member-row";
        memberRow.innerHTML = `
            <div class="member-profile-info">
                <div class="member-avatar avatar-${idx % 6}">${initials}</div>
                <div class="member-details">
                    <span class="member-name">${escapeHTML(member)}</span>
                    <span class="member-paid">Pagado total: ${paid.toFixed(2)}€</span>
                </div>
            </div>
            <div class="member-right-area">
                <button class="member-delete-btn" onclick="deleteMember('${escapeHTML(member)}')" title="Eliminar Amigo" style="opacity: 1;">&times;</button>
            </div>
        `;
        container.appendChild(memberRow);
    });
}

/**
 * Dibuja la lista de balances netos (pestaña Balances)
 */
function renderBalancesList(balances) {
    const container = document.getElementById("list-balances");
    container.innerHTML = "";

    const sortedMembers = Array.from(members).sort();
    
    // Actualizar el contador del badge de balances
    document.getElementById("badge-balances-count").textContent = `${sortedMembers.length} amigo${sortedMembers.length !== 1 ? 's' : ''}`;
    
    if (sortedMembers.length === 0) {
        container.innerHTML = `
            <div class="empty-state-small">
                <p>No hay amigos agregados. Añade amigos en la pestaña "Amigos" primero.</p>
            </div>
        `;
        return;
    }

    // Contar cuánto ha pagado realmente cada persona (solo de gastos reales)
    const paidByMember = {};
    members.forEach(m => paidByMember[m] = 0);
    expenses.forEach(exp => {
        if (!exp.isPayment && paidByMember[exp.payer] !== undefined) {
            paidByMember[exp.payer] += exp.amount;
        }
    });

    sortedMembers.forEach((member, idx) => {
        const bal = balances[member] || 0;
        const paid = paidByMember[member] || 0;
        const initials = member.substring(0, 2).toUpperCase();
        
        let statusClass = "balance-neutral";
        let sign = "";
        let label = "Está al día";

        if (bal > 0.019) {
            statusClass = "balance-positive";
            sign = "+";
            label = "Le deben";
        } else if (bal < -0.019) {
            statusClass = "balance-negative";
            sign = "";
            label = "Debe pagar";
        }

        const memberRow = document.createElement("div");
        memberRow.className = "member-row";
        memberRow.innerHTML = `
            <div class="member-profile-info">
                <div class="member-avatar avatar-${idx % 6}">${initials}</div>
                <div class="member-details">
                    <span class="member-name">${escapeHTML(member)}</span>
                    <span class="member-paid">Aportado: ${paid.toFixed(2)}€</span>
                </div>
            </div>
            <div class="member-balance-wrapper">
                <span class="balance-value ${statusClass}">${sign}${bal.toFixed(2)}€</span>
                <span class="balance-label">${label}</span>
            </div>
        `;
        container.appendChild(memberRow);
    });
}

/**
 * Renderiza la representación gráfica con bolas (bubble chart) de los saldos
 */
function renderBalancesChart(balances) {
    const container = document.getElementById("chart-balances-bubbles");
    if (!container) return;

    if (members.size === 0) {
        container.style.display = "none";
        container.innerHTML = "";
        return;
    }

    container.style.display = "flex";
    container.innerHTML = "";

    // Calcular el balance absoluto máximo para escalar
    let maxAbsBalance = 0;
    const memberBalances = [];

    members.forEach(member => {
        const bal = balances[member] || 0;
        const absBal = Math.abs(bal);
        if (absBal > maxAbsBalance) {
            maxAbsBalance = absBal;
        }
        memberBalances.push({ member, bal, absBal });
    });

    // Ordenar de mayor balance absoluto a menor (para una mejor distribución visual)
    memberBalances.sort((a, b) => b.absBal - a.absBal);

    const minSize = 90; // px
    const maxSize = 170; // px

    memberBalances.forEach(({ member, bal, absBal }) => {
        // Calcular tamaño de la bola
        let size = minSize;
        if (maxAbsBalance > 0) {
            size = minSize + (absBal / maxAbsBalance) * (maxSize - minSize);
        }

        // Determinar clase y signo
        let statusClass = "neu";
        let sign = "";
        if (bal > 0.019) {
            statusClass = "pos";
            sign = "+";
        } else if (bal < -0.019) {
            statusClass = "neg";
            sign = "";
        }

        // Calcular tamaños de fuente proporcionales
        const nameFontSize = Math.max(11, Math.min(15, 11 + (size - minSize) * 0.05));
        const amountFontSize = Math.max(12, Math.min(22, 12 + (size - minSize) * 0.12));

        const bubble = document.createElement("div");
        bubble.className = `balance-bubble ${statusClass}`;
        bubble.style.width = `${size}px`;
        bubble.style.height = `${size}px`;
        
        // Usar title para mostrar el nombre completo y saldo detallado al pasar el ratón
        const formattedBal = bal.toFixed(2);
        bubble.title = `${member}: ${bal > 0 ? '+' : ''}${formattedBal}€`;

        bubble.innerHTML = `
            <div class="bubble-name" style="font-size: ${nameFontSize}px;">${escapeHTML(member)}</div>
            <div class="bubble-amount" style="font-size: ${amountFontSize}px;">${sign}${formattedBal}€</div>
        `;

        container.appendChild(bubble);
    });
}

/**
 * Renderiza visualmente la propuesta de liquidación de cuentas (con checkboxes)
 */
function renderSettlementsList(transactions) {
    const container = document.getElementById("list-settlements");
    const copyBtn = document.getElementById("btn-copy-proposal");

    if (transactions.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-emoji">🎉</span>
                <p>¡Cuentas claras! Todos están al día y no hacen falta transferencias.</p>
            </div>
        `;
        copyBtn.disabled = true;
        return;
    }

    container.innerHTML = "";
    copyBtn.disabled = false;

    const sortedMembers = Array.from(members).sort();

    transactions.forEach(t => {
        const fromIdx = sortedMembers.indexOf(t.from);
        const toIdx = sortedMembers.indexOf(t.to);
        const key = `${t.from}_${t.to}_${t.amount.toFixed(2)}`;
        const isCompleted = completedSettlements.has(key);

        const cardWrapper = document.createElement("div");
        cardWrapper.className = "settlement-card-wrapper";
        cardWrapper.innerHTML = `
            <div class="settlement-card ${isCompleted ? 'is-completed' : ''}">
                <div class="settlement-direction">
                    <div class="settlement-checkbox-wrapper">
                        <input type="checkbox" class="settle-checkbox" onchange="toggleSettlement('${key}')" ${isCompleted ? 'checked' : ''} title="Marcar como completado">
                    </div>
                    <div class="settlement-actor">
                        <div class="mini-avatar avatar-${fromIdx !== -1 ? fromIdx % 6 : 0}">${t.from.substring(0, 2).toUpperCase()}</div>
                        <span class="settlement-actor-name" title="${escapeHTML(t.from)}">${escapeHTML(t.from)}</span>
                    </div>
                    <div class="settlement-arrow-wrapper">
                        <div class="settlement-arrow-line"></div>
                        <span class="settlement-transfer-text">${isCompleted ? 'pagó a' : 'debe pagar'}</span>
                    </div>
                    <div class="settlement-actor">
                        <div class="mini-avatar avatar-${toIdx !== -1 ? toIdx % 6 : 0}">${t.to.substring(0, 2).toUpperCase()}</div>
                        <span class="settlement-actor-name" title="${escapeHTML(t.to)}">${escapeHTML(t.to)}</span>
                    </div>
                </div>
                <div class="settlement-amount-box">
                    <span class="settlement-amount">${t.amount.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}€</span>
                    <div class="settlement-action-hint">${isCompleted ? 'Completado' : 'Bizum / Efectivo'}</div>
                    <button class="btn-details-toggle" onclick="window.toggleSettlementDetails('${escapeHTML(t.from)}', '${escapeHTML(t.to)}', this)">Ver desglose ▾</button>
                </div>
            </div>
            <div class="settlement-details-panel" style="display: none;"></div>
        `;
        container.appendChild(cardWrapper);
    });
}

/**
 * Renderiza el feed de gastos aplicando búsquedas y filtros
 */
function renderExpensesFeed() {
    const container = document.getElementById("list-expenses");
    const searchQuery = document.getElementById("input-search").value.toLowerCase();
    const payerFilter = document.getElementById("select-filter-payer").value;

    // Obtener filtro de tipo de gasto activo (Todos / Gastos / Pagos)
    const activeTypeBtn = document.querySelector(".type-filter-btn.active");
    const activeType = activeTypeBtn ? activeTypeBtn.dataset.type : "all";

    // Filtrar gastos
    const filteredExpenses = expenses.filter(exp => {
        const matchesSearch = exp.description.toLowerCase().includes(searchQuery) ||
                              exp.payer.toLowerCase().includes(searchQuery);
        const matchesPayer = payerFilter === "all" || exp.payer === payerFilter;
        const matchesType = activeType === "all" || 
                            (activeType === "expenses" && !exp.isPayment) ||
                            (activeType === "payments" && exp.isPayment);
        return matchesSearch && matchesPayer && matchesType;
    });

    if (filteredExpenses.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-emoji">🔍</span>
                <p>No se encontraron gastos con los criterios de búsqueda actuales.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = "";
    const sortedMembers = Array.from(members).sort();

    // Ordenar gastos: los más recientes arriba
    filteredExpenses.sort((a, b) => new Date(b.date) - new Date(a.date));

    filteredExpenses.forEach(exp => {
        const payerIdx = sortedMembers.indexOf(exp.payer);
        const initials = exp.payer.substring(0, 2).toUpperCase();
        
        // Formatear fecha bonita
        let dateLabel = exp.date;
        try {
            const dateParts = exp.date.split("-");
            if (dateParts.length === 3) {
                dateLabel = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
            }
        } catch(e) {}

        const card = document.createElement("div");
        const isPayment = exp.isPayment;
        card.className = `expense-card ${exp.isManual ? 'is-manual' : ''} ${isPayment ? 'is-payment' : ''}`;
        
        const badgeText = isPayment ? "Pago" : `Entre ${exp.participants ? exp.participants.length : members.size}`;
        const descHTML = isPayment ? `✨ <i>${escapeHTML(exp.description)}</i>` : escapeHTML(exp.description);
        const payerLabel = isPayment ? "Enviado por" : "Pagado por";
        
        card.innerHTML = `
            <div class="expense-main-info">
                <div class="expense-avatar ${isPayment ? 'avatar-payment' : `avatar-${payerIdx !== -1 ? payerIdx % 6 : 0}`}">${isPayment ? '💸' : initials}</div>
                <div class="expense-meta-details">
                    <div class="expense-title-row">
                        <span class="expense-description">${descHTML}</span>
                        <span class="expense-badge-split ${isPayment ? 'badge-payment' : ''}">${badgeText}</span>
                    </div>
                    <span class="expense-payer-name">${payerLabel} <strong>${escapeHTML(exp.payer)}</strong> • <span class="expense-date-label">${dateLabel}</span></span>
                </div>
            </div>
            <div class="expense-action-area">
                <span class="expense-amount-display ${isPayment ? 'amount-payment' : ''}">${exp.amount.toFixed(2)}€</span>
                <div class="expense-actions-menu">
                    <button class="btn-icon btn-edit" onclick="window.openEditExpenseModal('${exp.id}')" title="${isPayment ? 'Editar Pago' : 'Editar Gasto'}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                    <button class="btn-icon btn-delete" onclick="deleteExpense('${exp.id}')" title="${isPayment ? 'Eliminar Pago' : 'Eliminar Gasto'}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

/**
 * Actualiza los elementos select de filtrado con los participantes actuales
 */
function updateFilterDropdowns() {
    const filterSelect = document.getElementById("select-filter-payer");
    const activeValue = filterSelect.value;
    
    filterSelect.innerHTML = '<option value="all">Todos los pagadores</option>';
    
    Array.from(members).sort().forEach(m => {
        const option = document.createElement("option");
        option.value = m;
        option.textContent = m;
        filterSelect.appendChild(option);
    });

    // Restaurar valor anterior si sigue existiendo
    if (members.has(activeValue)) {
        filterSelect.value = activeValue;
    } else {
        filterSelect.value = "all";
    }
}

// ==========================================================================
// INTERACCIONES Y EVENTOS DE MODAL
// ==========================================================================

/**
 * Configura los event listeners de toda la app
 */
function setupEventListeners() {
    // Tabs de Navegación Principal
    const mainTabs = document.querySelectorAll(".tab-nav-btn");
    mainTabs.forEach(btn => {
        btn.addEventListener("click", () => {
            mainTabs.forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".tab-section").forEach(s => s.classList.remove("active"));
            
            btn.classList.add("active");
            const targetId = btn.dataset.target;
            document.getElementById(targetId).classList.add("active");
        });
    });

    // Buscar y filtrar
    document.getElementById("input-search").addEventListener("input", renderExpensesFeed);
    document.getElementById("select-filter-payer").addEventListener("change", renderExpensesFeed);

    // Filtro de tipo de gasto (Segmentado)
    const typeBtns = document.querySelectorAll(".type-filter-btn");
    typeBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            typeBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderExpensesFeed();
        });
    });

    // Modales - Abrir Importar
    document.getElementById("btn-import-chat").addEventListener("click", () => {
        openModal("modal-import");
        document.getElementById("textarea-chat").value = "";
        document.getElementById("lbl-selected-file").textContent = "Ningún archivo seleccionado";
    });

    // Modales - Cerrar Importar
    document.getElementById("btn-close-import").addEventListener("click", () => closeModal("modal-import"));
    document.getElementById("btn-cancel-import").addEventListener("click", () => closeModal("modal-import"));

    // Pestañas del Importador
    const tabButtons = document.querySelectorAll(".tab-btn");
    tabButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
            tabButtons.forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
            
            btn.classList.add("active");
            const tabId = `tab-${btn.dataset.tab}`;
            document.getElementById(tabId).classList.add("active");
        });
    });

    // Dropzone del Importador
    const dropZone = document.getElementById("file-drop-zone");
    const fileInput = document.getElementById("input-file-chat");

    dropZone.addEventListener("click", () => fileInput.click());
    
    fileInput.addEventListener("change", (e) => {
        if (e.target.files.length > 0) {
            handleSelectedFile(e.target.files[0]);
        }
    });

    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("dragover");
    });

    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length > 0) {
            fileInput.files = e.dataTransfer.files;
            handleSelectedFile(e.dataTransfer.files[0]);
        }
    });

    // Procesar Chat Importado
    document.getElementById("btn-process-chat").addEventListener("click", () => {
        const activeTab = document.querySelector(".tab-btn.active").dataset.tab;
        
        if (activeTab === "paste") {
            const rawText = document.getElementById("textarea-chat").value;
            if (!rawText.trim()) {
                showToast("Por favor, pega el texto de tu chat", "warning");
                return;
            }
            processChatText(rawText, "pasted");
            closeModal("modal-import");
        } else {
            const file = fileInput.files[0];
            if (!file) {
                showToast("Por favor, selecciona un archivo .txt primero", "warning");
                return;
            }
            const reader = new FileReader();
            reader.onload = (e) => {
                processChatText(e.target.result, "pasted");
                closeModal("modal-import");
            };
            reader.readAsText(file);
        }
    });

    // Recargar desde archivo
    document.getElementById("btn-reload-file").addEventListener("click", async () => {
        await fetchChatFile();
    });

    // Copiar propuesta de pagos
    document.getElementById("btn-copy-proposal").addEventListener("click", copyProposalToClipboard);

    // Modal Añadir Gasto - Abrir
    document.getElementById("btn-add-expense-manual").addEventListener("click", () => {
        openAddExpenseModal();
    });

    // Modal Añadir Gasto - Cerrar
    document.getElementById("btn-close-expense").addEventListener("click", () => closeModal("modal-expense"));
    document.getElementById("btn-cancel-expense").addEventListener("click", () => closeModal("modal-expense"));

    // Guardar Gasto Manual
    document.getElementById("form-expense").addEventListener("submit", saveExpenseForm);

    // Añadir Miembro Manual
    document.getElementById("form-add-member").addEventListener("submit", (e) => {
        e.preventDefault();
        const input = document.getElementById("input-member-name");
        const name = input.value.trim();
        if (!name) return;
        
        if (members.has(name)) {
            showToast("Este miembro ya existe", "warning");
            return;
        }
        
        members.add(name);
        
        if (dataSource === "demo") {
            dataSource = "local";
        }
        
        input.value = "";
        saveToLocalStorage();
        updateAppUI();
        showToast(`Miembro "${name}" añadido`);
    });

    // Vaciar Todo
    document.getElementById("btn-clear-all").addEventListener("click", () => {
        if (confirm("¿Seguro que deseas vaciar todos los datos? Se borrarán todos los gastos, miembros y liquidaciones.")) {
            expenses = [];
            members = new Set();
            completedSettlements.clear();
            dataSource = "local";
            saveToLocalStorage();
            updateAppUI();
            showToast("Datos vaciados. Inicia de cero.", "info");
        }
    });

    // Abrir Modal de Compartir
    document.getElementById("btn-share-options").addEventListener("click", () => {
        openModal("modal-share");
    });

    // Cerrar Modal de Compartir
    document.getElementById("btn-close-share").addEventListener("click", () => closeModal("modal-share"));
    document.getElementById("btn-cancel-share").addEventListener("click", () => closeModal("modal-share"));

    // Copiar Enlace Compartido
    document.getElementById("btn-generate-link").addEventListener("click", generateShareLink);

    // Exportar JSON
    document.getElementById("btn-export-json").addEventListener("click", exportToJSON);

    // Importar JSON (Trigger)
    const jsonFileInput = document.getElementById("input-import-json");
    document.getElementById("btn-trigger-import-json").addEventListener("click", () => {
        jsonFileInput.click();
    });

    // Procesar archivo JSON cargado
    jsonFileInput.addEventListener("change", (e) => {
        if (e.target.files.length > 0) {
            importFromJSON(e.target.files[0]);
            e.target.value = ""; // Limpiar input para permitir cargar el mismo archivo
        }
    });
}

/**
 * Control de archivos seleccionados en la dropzone
 */
function handleSelectedFile(file) {
    const label = document.getElementById("lbl-selected-file");
    if (file && file.name.endsWith(".txt")) {
        label.textContent = `Archivo seleccionado: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    } else {
        label.textContent = "Error: Selecciona solo archivos de texto (.txt)";
        showToast("Formato de archivo no válido", "danger");
    }
}

/**
 * Abre un modal por ID
 */
function openModal(id) {
    document.getElementById(id).classList.add("open");
}

/**
 * Cierra un modal por ID
 */
function closeModal(id) {
    document.getElementById(id).classList.remove("open");
}

/**
 * Abre el modal de añadir gasto en modo creación
 */
function openAddExpenseModal() {
    // Si no hay miembros detectados todavía, añadir un miembro temporal o avisar
    if (members.size === 0) {
        showToast("Carga un chat o añade participantes primero", "warning");
        return;
    }

    document.getElementById("modal-expense-title").textContent = "Añadir Gasto Manual";
    document.getElementById("expense-id-edit").value = "";
    document.getElementById("expense-description").value = "";
    document.getElementById("expense-amount").value = "";
    
    // Fecha por defecto hoy en formato local YYYY-MM-DD
    const today = new Date().toISOString().split("T")[0];
    document.getElementById("expense-date").value = today;

    // Cargar select de pagadores y lista de checkboxes
    populateModalMembersArea();

    openModal("modal-expense");
}

/**
 * Abre el modal de gastos en modo edición
 */
window.openEditExpenseModal = function(id) {
    const exp = expenses.find(e => e.id === id);
    if (!exp) return;

    document.getElementById("modal-expense-title").textContent = "Editar Gasto";
    document.getElementById("expense-id-edit").value = exp.id;
    document.getElementById("expense-description").value = exp.description;
    document.getElementById("expense-amount").value = exp.amount;
    document.getElementById("expense-date").value = exp.date;

    populateModalMembersArea();

    // Rellenar pagador
    document.getElementById("expense-payer").value = exp.payer;

    // Rellenar checkboxes de participantes
    const checkboxes = document.querySelectorAll('input[name="expense-participant"]');
    checkboxes.forEach(cb => {
        cb.checked = exp.participants.includes(cb.value);
    });

    openModal("modal-expense");
};

/**
 * Popula los select y checkboxes del modal de gasto
 */
function populateModalMembersArea() {
    const payerSelect = document.getElementById("expense-payer");
    const checkboxesContainer = document.getElementById("expense-participants-list");

    payerSelect.innerHTML = "";
    checkboxesContainer.innerHTML = "";

    const sortedMembers = Array.from(members).sort();

    sortedMembers.forEach(m => {
        // Option para pagador
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        payerSelect.appendChild(opt);

        // Checkbox para participantes
        const label = document.createElement("label");
        label.className = "checkbox-label";
        label.innerHTML = `
            <input type="checkbox" name="expense-participant" value="${escapeHTML(m)}" checked>
            <span>${escapeHTML(m)}</span>
        `;
        checkboxesContainer.appendChild(label);
    });
}

/**
 * Guarda o actualiza un gasto en base al formulario
 */
function saveExpenseForm() {
    const id = document.getElementById("expense-id-edit").value;
    const payer = document.getElementById("expense-payer").value;
    const description = document.getElementById("expense-description").value.trim();
    const amountVal = parseFloat(document.getElementById("expense-amount").value);
    const date = document.getElementById("expense-date").value;

    // Obtener participantes seleccionados
    const checkboxes = document.querySelectorAll('input[name="expense-participant"]:checked');
    const participants = Array.from(checkboxes).map(cb => cb.value);

    if (!description) {
        showToast("Especifica un concepto", "warning");
        return;
    }
    if (isNaN(amountVal) || amountVal <= 0) {
        showToast("El importe debe ser mayor que cero", "warning");
        return;
    }
    if (participants.length === 0) {
        showToast("Debes seleccionar al menos un participante", "warning");
        return;
    }

    const roundedAmount = Math.round(amountVal * 100) / 100;

    if (id) {
        // Modo Edición
        const idx = expenses.findIndex(e => e.id === id);
        if (idx !== -1) {
            expenses[idx] = {
                ...expenses[idx],
                description,
                amount: roundedAmount,
                date,
                payer,
                participants,
                isManual: true // Marcar como editado manualmente
            };
            showToast("Gasto actualizado correctamente");
        }
    } else {
        // Modo Creación
        const newExp = {
            id: `manual-${Date.now()}`,
            description,
            amount: roundedAmount,
            date,
            payer,
            participants,
            isManual: true
        };
        expenses.push(newExp);
        showToast("Gasto añadido correctamente");
    }

    // Cambiar origen a local si agregamos/editamos manualmente
    if (dataSource === "demo") {
        dataSource = "local";
    }

    saveToLocalStorage();
    updateAppUI();
    closeModal("modal-expense");
}

/**
 * Elimina un gasto por su ID
 */
window.deleteExpense = function(id) {
    if (confirm("¿Seguro que deseas eliminar este gasto?")) {
        expenses = expenses.filter(e => e.id !== id);
        showToast("Gasto eliminado");
        
        if (dataSource === "demo") {
            dataSource = "local";
        }
        
        saveToLocalStorage();
        updateAppUI();
    }
};

window.deleteMember = function(name) {
    const hasPaid = expenses.some(e => e.payer === name);
    if (hasPaid) {
        showToast(`"${name}" ha pagado gastos. Elimina sus gastos primero.`, "danger");
        return;
    }

    if (confirm(`¿Seguro que deseas eliminar a "${name}"? Se le quitará de los gastos en los que participa.`)) {
        members.delete(name);
        
        // Quitar de los participantes de todos los gastos
        expenses.forEach(exp => {
            if (exp.participants) {
                exp.participants = exp.participants.filter(p => p !== name);
            }
        });
        
        // Si algún gasto se queda sin participantes, borrarlo
        expenses = expenses.filter(exp => !exp.participants || exp.participants.length > 0);
        
        if (dataSource === "demo") {
            dataSource = "local";
        }
        
        saveToLocalStorage();
        updateAppUI();
        showToast(`Miembro "${name}" eliminado`);
    }
};

window.toggleSettlement = function(key) {
    if (completedSettlements.has(key)) {
        completedSettlements.delete(key);
    } else {
        completedSettlements.add(key);
    }
    saveToLocalStorage();
    const { transactions } = solveDebts();
    renderSettlementsList(transactions);
};

/**
 * Copia la propuesta de pagos estructurada al portapapeles
 */
function copyProposalToClipboard() {
    const { transactions } = solveDebts();
    if (transactions.length === 0) return;

    let text = "*💰 PROPUESTA DE PAGOS - GATOS VIAJE AMIGOS 🐱✈️*\n";
    text += "Aquí tenéis la forma más sencilla de saldar deudas con el mínimo número de transferencias:\n\n";

    transactions.forEach(t => {
        text += `• *${t.from}* debe pagar *${t.amount.toFixed(2)}€* a *${t.to}*\n`;
    });
    
    text += "\n¡Cuentas liquidadas! 🎉";

    navigator.clipboard.writeText(text).then(() => {
        showToast("¡Propuesta copiada al portapapeles! Lista para pegar en WhatsApp.");
    }).catch(err => {
        console.error("Error al copiar al portapapeles", err);
        showToast("No se pudo copiar automáticamente. Inténtalo de nuevo.", "danger");
    });
}

// ==========================================================================
// AUXILIARES Y UTILIDADES
// ==========================================================================

/**
 * Muestra una alerta flotante (Toast)
 */
function showToast(message, type = "success") {
    const toast = document.getElementById("app-toast");
    toast.textContent = message;
    
    // Configuración visual según tipo
    toast.className = "toast show";
    if (type === "danger") {
        toast.style.borderColor = "var(--danger)";
        toast.style.boxShadow = "0 10px 25px rgba(239, 68, 68, 0.2)";
    } else if (type === "warning") {
        toast.style.borderColor = "var(--warning)";
        toast.style.boxShadow = "0 10px 25px rgba(245, 158, 11, 0.2)";
    } else {
        toast.style.borderColor = "var(--primary)";
        toast.style.boxShadow = "0 10px 25px rgba(95, 93, 236, 0.2)";
    }

    // Ocultar a los 3 segundos
    setTimeout(() => {
        toast.classList.remove("show");
    }, 3200);
}

/**
 * Actualiza el banner de estado intermedio
 */
function updateBannerStatus(type, msg) {
    const dot = document.getElementById("data-status-dot");
    const text = document.getElementById("data-status-text");
    
    dot.className = "status-indicator pulsating ";
    if (type === "loading") {
        dot.classList.add("warning");
    }
    text.textContent = msg;
}

/**
 * Guarda el estado actual en el almacenamiento local
 */
function saveToLocalStorage() {
    localStorage.setItem("gatos_expenses", JSON.stringify(expenses));
    localStorage.setItem("gatos_members", JSON.stringify(Array.from(members)));
    localStorage.setItem("gatos_source", dataSource);
    localStorage.setItem("gatos_completed_settlements", JSON.stringify(Array.from(completedSettlements)));
}

/**
 * Escapa strings de HTML para evitar XSS
 */
function escapeHTML(str) {
    if (typeof str !== "string") return "";
    return str.replace(/[&<>"']/g, function(m) {
        switch (m) {
            case "&": return "&amp;";
            case "<": return "&lt;";
            case ">": return "&gt;";
            case "\"": return "&quot;";
            case "'": return "&#039;";
            default: return m;
        }
    });
}

// ==========================================================================
// COMPARTIR Y EXPORTAR (SIN BBDD) - FUNCIONES AUXILIARES
// ==========================================================================

/**
 * Minifica el JSON del estado para optimizar el tamaño de la URL
 */
function minifyState(membersList, expensesList) {
    const minifiedExpenses = expensesList.map(e => ({
        d: e.description,
        a: e.amount,
        t: e.date,
        p: e.payer,
        m: e.participants
    }));
    return {
        u: membersList,
        e: minifiedExpenses
    };
}

/**
 * Descomprime el estado minificado de vuelta a su formato original
 */
function magnifyState(minState) {
    const magnifiedExpenses = minState.e.map((e, idx) => ({
        id: `shared-${idx}-${Date.now()}`,
        description: e.d,
        amount: e.a,
        date: e.t,
        payer: e.p,
        participants: e.m,
        isManual: true
    }));
    return {
        members: new Set(minState.u),
        expenses: magnifiedExpenses
    };
}

/**
 * Codificador Base64 UTF-8 seguro para emojis y acentos
 */
function safeB64Encode(str) {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(match, p1) {
        return String.fromCharCode('0x' + p1);
    }));
}

/**
 * Decodificador Base64 UTF-8 seguro
 */
function safeB64Decode(str) {
    return decodeURIComponent(atob(str).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
}

/**
 * Genera el enlace y lo copia al portapapeles
 */
function generateShareLink() {
    if (members.size === 0) {
        showToast("Añade al menos un amigo para poder compartir", "warning");
        return;
    }
    
    const state = minifyState(Array.from(members), expenses);
    const json = JSON.stringify(state);
    
    try {
        const hash = safeB64Encode(json);
        const shareLink = window.location.origin + window.location.pathname + '#trip=' + hash;
        
        navigator.clipboard.writeText(shareLink).then(() => {
            showToast("¡Enlace de compartir copiado! Envíalo por WhatsApp.");
            closeModal("modal-share");
        }).catch(err => {
            console.error("Error al copiar enlace", err);
            prompt("Copia este enlace de compartir:", shareLink);
            closeModal("modal-share");
        });
    } catch (e) {
        console.error("Error al codificar el enlace", e);
        showToast("Error al generar el enlace de compartir", "danger");
    }
}

/**
 * Exporta el viaje actual a un archivo JSON físico
 */
function exportToJSON() {
    if (members.size === 0 && expenses.length === 0) {
        showToast("No hay datos para exportar", "warning");
        return;
    }
    
    const state = {
        members: Array.from(members),
        expenses: expenses
    };
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement("a");
    a.href = url;
    a.download = `gastos_viaje_${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Copia de seguridad descargada (JSON)");
    closeModal("modal-share");
}

/**
 * Importa el estado del viaje desde un archivo JSON físico
 */
function importFromJSON(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const state = JSON.parse(e.target.result);
            if (state.members && state.expenses) {
                expenses = state.expenses;
                members = new Set(state.members);
                completedSettlements.clear();
                dataSource = "local";
                saveToLocalStorage();
                updateAppUI();
                showToast("Datos importados con éxito");
                closeModal("modal-share");
            } else {
                showToast("Formato de archivo JSON no válido", "danger");
            }
        } catch (err) {
            console.error("Error parseando JSON importado", err);
            showToast("Error al leer el archivo JSON", "danger");
        }
    };
    reader.readAsText(file);
}

/**
 * Revisa si la URL contiene datos codificados de un viaje compartido y los carga
 */
function checkUrlHashTrip() {
    if (window.location.hash.startsWith("#trip=")) {
        const hash = window.location.hash.substring(6); // quitar '#trip='
        try {
            const json = safeB64Decode(hash);
            const minState = JSON.parse(json);
            
            if (minState.u && minState.e) {
                const magnified = magnifyState(minState);
                expenses = magnified.expenses;
                members = magnified.members;
                completedSettlements.clear();
                dataSource = "local";
                saveToLocalStorage();
                updateAppUI();
                window.history.replaceState(null, null, window.location.pathname);
                showToast("Viaje cargado desde el enlace compartido");
            } else if (minState.members && minState.expenses) {
                expenses = minState.expenses;
                members = new Set(minState.members);
                completedSettlements.clear();
                dataSource = "local";
                saveToLocalStorage();
                updateAppUI();
                window.history.replaceState(null, null, window.location.pathname);
                showToast("Viaje cargado desde el enlace compartido");
            }
        } catch (e) {
            console.error("Error al cargar viaje desde el hash", e);
            showToast("El enlace compartido no es válido o está dañado", "danger");
        }
    }
}

/**
 * Inicializa y configura la lógica del tema (Día/Noche)
 */
function initTheme() {
    const themeToggleBtn = document.getElementById("btn-theme-toggle");
    if (!themeToggleBtn) return;

    themeToggleBtn.addEventListener("click", () => {
        const isLight = document.body.classList.toggle("light-theme");
        localStorage.setItem("gatos_theme", isLight ? "light" : "dark");
        updateThemeUI();
        showToast(`Tema cambiado a modo ${isLight ? 'día' : 'noche'}`);
    });

    // Sincronizar el botón inicialmente
    updateThemeUI();
}

/**
 * Actualiza los iconos y el texto del botón del tema según el estado actual
 */
function updateThemeUI() {
    const isLight = document.body.classList.contains("light-theme");
    const darkIcon = document.getElementById("theme-icon-dark");
    const lightIcon = document.getElementById("theme-icon-light");
    const themeText = document.getElementById("theme-text");
    
    if (!darkIcon || !lightIcon || !themeText) return;

    if (isLight) {
        darkIcon.style.display = "inline";
        lightIcon.style.display = "none";
        themeText.textContent = "Modo Oscuro";
    } else {
        darkIcon.style.display = "none";
        lightIcon.style.display = "inline";
        themeText.textContent = "Modo Claro";
    }
}

/**
 * Alterna la visualización del panel de desglose de deudas y lo renderiza
 */
window.toggleSettlementDetails = function(debtor, creditor, btn) {
    const cardWrapper = btn.closest('.settlement-card-wrapper');
    if (!cardWrapper) return;
    
    const panel = cardWrapper.querySelector('.settlement-details-panel');
    if (!panel) return;
    
    const isVisible = panel.style.display === 'flex';
    
    if (isVisible) {
        panel.style.display = 'none';
        btn.textContent = 'Ver desglose ▾';
    } else {
        panel.style.display = 'flex';
        btn.textContent = 'Ocultar desglose ▴';
        renderSettlementBreakdown(debtor, creditor, panel);
    }
};

/**
 * Renderiza el desglose detallado de los gastos asociados a una deuda
 */
function renderSettlementBreakdown(debtor, creditor, panel) {
    // 1. Obtener gastos pagados por creditor donde debtor participa
    const directExpenses = expenses.filter(exp => 
        exp.payer === creditor && 
        exp.participants && 
        exp.participants.includes(debtor) &&
        !exp.isPayment
    );
    
    // 2. Obtener gastos pagados por otros donde debtor participa
    const otherExpenses = expenses.filter(exp => 
        exp.payer !== creditor && 
        exp.payer !== debtor && 
        exp.participants && 
        exp.participants.includes(debtor) &&
        !exp.isPayment
    );

    let html = '';

    // Genera el HTML de un item de gasto con su estado de pago
    const getExpenseItemHTML = (exp) => {
        const totalParticipants = exp.participants.length;
        const originalShare = exp.amount / totalParticipants;
        
        // Calcular pagos ya realizados asociados a este gasto
        const payments = expenses.filter(p => p.relatedExpenseId === exp.id && p.payer === debtor);
        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
        const remaining = Math.max(0, originalShare - totalPaid);
        const isFullyPaid = remaining < 0.019;

        let dateLabel = exp.date;
        try {
            const dateParts = exp.date.split("-");
            if (dateParts.length === 3) {
                dateLabel = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
            }
        } catch(e) {}

        // Listar los pagos específicos realizados para este gasto para poder deshacerlos
        let paymentsHTML = "";
        if (payments.length > 0) {
            paymentsHTML = `<div class="settlement-detail-payments-list">`;
            payments.forEach(p => {
                let pDateLabel = p.date;
                try {
                    const pDateParts = p.date.split("-");
                    if (pDateParts.length === 3) {
                        pDateLabel = `${pDateParts[2]}/${pDateParts[1]}`;
                    }
                } catch(e) {}
                paymentsHTML += `
                    <div class="settlement-detail-payment-row">
                        <span>💸 Pago registrado: <strong>${p.amount.toFixed(2)}€</strong> (${pDateLabel})</span>
                        <button class="btn-undo-payment" onclick="window.deletePaymentFromBreakdown('${p.id}', '${escapeHTML(debtor)}', '${escapeHTML(p.participants && p.participants[0] ? p.participants[0] : creditor)}', this)" title="Deshacer este pago y restaurar la deuda">Deshacer</button>
                    </div>
                `;
            });
            paymentsHTML += `</div>`;
        }

        return `
            <div class="settlement-detail-item" id="detail-item-${exp.id}" style="flex-direction: column; align-items: stretch; gap: 8px;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%;">
                    <div class="settlement-detail-info">
                        <span class="settlement-detail-desc">${escapeHTML(exp.description)}</span>
                        <span class="settlement-detail-meta">
                            Pagado por ${escapeHTML(exp.payer)} el ${dateLabel} • Total: ${exp.amount.toFixed(2)}€ (entre ${totalParticipants})
                        </span>
                    </div>
                    <div class="settlement-detail-amount">
                        <div style="display: flex; flex-direction: column; align-items: flex-end;">
                            <span class="settlement-detail-value">${remaining.toFixed(2)}€</span>
                            <span class="balance-label">${isFullyPaid ? 'Liquidado' : `Tu parte: ${originalShare.toFixed(2)}€`}</span>
                        </div>
                        
                        ${!isFullyPaid ? `
                            <div class="settlement-detail-actions">
                                <button class="btn-detail-action edit-exp" onclick="window.openEditExpenseModal('${exp.id}')" title="Editar este gasto original">Editar</button>
                                <button class="btn-detail-action pay-partial" onclick="window.showPartialPayForm('${exp.id}', '${escapeHTML(debtor)}', '${escapeHTML(exp.payer)}', this)" title="Pagar una parte de este gasto">Pagar Parte</button>
                                <button class="btn-detail-action pay-total" onclick="window.settleExpensePartially('${exp.id}', '${escapeHTML(debtor)}', '${escapeHTML(exp.payer)}', ${remaining})" title="Liquidar totalmente tu parte">Pagar Todo</button>
                            </div>
                        ` : `
                            <div class="settlement-detail-actions" style="margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                                <span class="status-indicator success" style="width: 8px; height: 8px; display: inline-block;"></span>
                                <span style="font-size: 0.7rem; color: var(--success); font-weight: 600;">Pagado</span>
                            </div>
                        `}
                        <div class="partial-pay-container" style="display: none; width: 100%;"></div>
                    </div>
                </div>
                ${paymentsHTML}
            </div>
        `;
    };

    if (directExpenses.length > 0) {
        html += `<div class="settlement-details-title">Deudas directas con ${escapeHTML(creditor)}</div>`;
        directExpenses.forEach(exp => {
            html += getExpenseItemHTML(exp);
        });
    }

    if (otherExpenses.length > 0) {
        html += `<div class="settlement-details-title" style="margin-top: 10px;">Otras deudas de ${escapeHTML(debtor)} en el viaje</div>`;
        otherExpenses.forEach(exp => {
            html += getExpenseItemHTML(exp);
        });
    }

    if (directExpenses.length === 0 && otherExpenses.length === 0) {
        html += `<div class="empty-state-small"><p>No hay deudas directas ni participaciones en gastos pendientes.</p></div>`;
    }

    panel.innerHTML = html;
}

/**
 * Muestra el formulario inline de pago parcial
 */
window.showPartialPayForm = function(expenseId, debtor, creditor, btn) {
    const parent = btn.closest('.settlement-detail-amount');
    if (!parent) return;
    
    const container = parent.querySelector('.partial-pay-container');
    if (!container) return;
    
    // Ocultar acciones
    const actions = parent.querySelector('.settlement-detail-actions');
    if (actions) actions.style.display = 'none';
    
    container.style.display = 'block';
    container.innerHTML = `
        <div class="partial-pay-form">
            <input type="number" class="partial-pay-input" min="0.01" step="0.01" placeholder="Importe" required>
            <button class="btn-partial-submit" onclick="window.submitPartialPay('${expenseId}', '${escapeHTML(debtor)}', '${escapeHTML(creditor)}', this)">Confirmar</button>
            <button class="btn-partial-cancel" onclick="window.cancelPartialPay(this)">X</button>
        </div>
    `;
};

/**
 * Cancela el pago parcial inline
 */
window.cancelPartialPay = function(btn) {
    const parent = btn.closest('.settlement-detail-amount');
    if (!parent) return;
    
    const container = parent.querySelector('.partial-pay-container');
    if (container) {
        container.style.display = 'none';
        container.innerHTML = '';
    }
    
    const actions = parent.querySelector('.settlement-detail-actions');
    if (actions) actions.style.display = 'flex';
};

/**
 * Confirma e introduce el pago parcial
 */
window.submitPartialPay = function(expenseId, debtor, creditor, btn) {
    const form = btn.closest('.partial-pay-form');
    if (!form) return;
    
    const input = form.querySelector('.partial-pay-input');
    const amount = parseFloat(input.value);
    
    if (isNaN(amount) || amount <= 0) {
        showToast("Por favor, introduce un importe válido", "warning");
        return;
    }
    
    window.settleExpensePartially(expenseId, debtor, creditor, amount);
};

/**
 * Registra una transferencia parcial/total de un gasto y actualiza
 */
window.settleExpensePartially = function(expenseId, debtor, creditor, amount) {
    const origExpense = expenses.find(e => e.id === expenseId);
    const desc = origExpense ? origExpense.description : "Gasto";
    
    const paymentExpense = {
        id: 'pay_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        description: `Pago: de ${debtor} a ${creditor} por "${desc}"`,
        amount: parseFloat(amount),
        date: new Date().toISOString().split("T")[0],
        payer: debtor,
        participants: [creditor],
        isManual: true,
        isPayment: true,
        relatedExpenseId: expenseId
    };
    
    expenses.push(paymentExpense);
    saveToLocalStorage();
    updateAppUI();
    showToast(`Registrado pago de ${amount.toFixed(2)}€ de ${debtor} a ${creditor}`);
};

/**
 * Elimina un pago registrado y restaura la deuda correspondiente
 */
window.deletePaymentFromBreakdown = function(paymentId, debtor, creditor, btn) {
    if (!confirm(`¿Seguro que quieres deshacer este pago y restaurar la deuda de ${debtor} con ${creditor}?`)) return;

    const index = expenses.findIndex(e => e.id === paymentId);
    if (index !== -1) {
        expenses.splice(index, 1);
        saveToLocalStorage();
        updateAppUI();
        showToast("Pago eliminado y deuda restaurada con éxito");
    } else {
        showToast("No se encontró el pago registrado", "danger");
    }
};
