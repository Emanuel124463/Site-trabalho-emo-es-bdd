/* =========================================================
   TRABALHOS EMOÇÕES — BANCO DE DADOS
   Supabase + fallback localStorage
   ========================================================= */
const STORAGE_KEY = "emocoes-em-foco-trabalhos";
const MIGRATION_KEY = "trabalhos-emocoes-local-migrated-v1";
const TABLE = "trabalhos";

let trabalhos = [];
let indiceEditando = null;
let indiceRemovendo = null;
let supabaseClient = null;
let bancoAtivo = false;
let usuarioAdmin = null;   // conta logada que é administradora
let usuarioLogado = null;  // qualquer conta logada (admin ou não)
let modoAuth = "entrar";
let toastTimer = null;
let authSeq = 0;      // evita que uma resposta antiga de login sobrescreva uma mais nova
let salvando = false;  // evita clique duplo em Adicionar/Salvar/Remover

const raiz = document.getElementById("conteudo");
const campo = document.getElementById("busca");
const limparBusca = document.getElementById("limparBusca");
const modal = document.getElementById("modal");
const adicionarModal = document.getElementById("adicionarModal");
const formAdicionar = document.getElementById("formAdicionar");
const abrirAdicionar = document.getElementById("abrirAdicionar");
const abrirLogin = document.getElementById("abrirLogin");
const removerModal = document.getElementById("removerModal");
const confirmarRemocao = document.getElementById("confirmarRemocao");
const toast = document.getElementById("toast");
const toastMessage = document.getElementById("toastMessage");
const toastIcon = document.getElementById("toastIcon");
const confettiContainer = document.getElementById("confettiContainer");
const loginModal = document.getElementById("loginModal");
const loginForm = document.getElementById("loginForm");
const dbStatus = document.getElementById("dbStatus");

// Só aceita links http:// ou https:// (bloqueia "javascript:", "data:" etc.)
function urlSegura(valor) {
  const v = String(valor || "").trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") ? v : "";
  } catch {
    return "";
  }
}

const DOMINIO_USUARIO = window.SUPABASE_CONFIG?.usuarioDominio || "emocoes.app";

// O Supabase exige e-mail: "Emanuel" vira "emanuel@emocoes.app" (quem digita "@" usa o e-mail como está).
function emailDeUsuario(texto) {
  const v = String(texto || "").trim().toLowerCase();
  return v.includes("@") ? v : `${v}@${DOMINIO_USUARIO}`;
}

function nomeDeUsuario(email) {
  const e = String(email || "");
  const fim = `@${DOMINIO_USUARIO}`;
  if (!e.toLowerCase().endsWith(fim)) return e;
  const n = e.slice(0, -fim.length);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function usuarioValido(texto) {
  return /^[a-z0-9._-]{3,30}$/i.test(String(texto || "").trim());
}

function semAcento(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function proximoNumero() {
  return trabalhos.reduce((m, t) => Math.max(m, parseInt(String(t.grupo).replace(/\D/g, ""), 10) || 0), 0) + 1;
}

function sessaoExpirou() {
  usuarioLogado = null;
  usuarioAdmin = null;
  atualizarEstadoAdmin();
  mostrarToast("Sem permissão: entre novamente na sua conta.", "error");
  abrirLoginModal("entrar");
}

function el(tag, cls, text, kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  (kids || []).forEach(k => e.appendChild(k));
  return e;
}

function mostrarToast(mensagem, tipo = "sucesso") {
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.classList.remove("show", "error");
  toastIcon.textContent = tipo === "error" ? "!" : "✓";
  toastMessage.textContent = mensagem;
  if (tipo === "error") toast.classList.add("error");
  requestAnimationFrame(() => toast.classList.add("show"));
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function setDbStatus(text, ok = true) {
  if (!dbStatus) return;
  dbStatus.textContent = text;
  dbStatus.classList.toggle("offline", !ok);
  dbStatus.classList.add("show");
  clearTimeout(setDbStatus.timer);
  setDbStatus.timer = setTimeout(() => dbStatus.classList.remove("show"), 4500);
}

function localCarregar() {
  try {
    const dados = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(dados) ? dados : [];
  } catch {
    return [];
  }
}

function localSalvar() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trabalhos));
  } catch (err) {
    console.warn("Não foi possível salvar localmente:", err);
    mostrarToast("Não foi possível salvar neste navegador.", "error");
  }
}

function configValida() {
  const c = window.SUPABASE_CONFIG || {};
  return window.supabase && c.url && c.key && !c.url.includes("COLE_AQUI") && !c.key.includes("COLE_AQUI");
}

function normalizar(t) {
  return {
    id: t.id || null,
    titulo: t.titulo || "",
    integrantes: t.integrantes || "",
    link: urlSegura(t.link),
    grupo: t.grupo || "Trabalho",
    formato: t.formato || "Trabalho",
    descricao: t.descricao || "Trabalho cadastrado pela turma.",
    criado_em: t.criado_em || t.created_at || null
  };
}

async function iniciarBanco() {
  if (!configValida()) {
    bancoAtivo = false;
    trabalhos = localCarregar().map(normalizar);
    setDbStatus(window.supabase ? "Modo local: configure o Supabase para salvar para todos." : "Não foi possível carregar o Supabase (sem internet?). Usando modo local.", false);
    desenhar();
    return;
  }

  try {
    supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.key);
    // Não use await com chamadas do Supabase DENTRO deste callback (pode travar o login).
    // Por isso o trabalho é adiado com setTimeout.
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => sincronizarAdmin(session?.user || null), 0);
    });
    bancoAtivo = true;
    const { data: sessionData } = await supabaseClient.auth.getSession();
    await sincronizarAdmin(sessionData?.session?.user || null);
    await carregarDoBanco();
    if (await migrarLocalSeNecessario()) await carregarDoBanco();
    setDbStatus("Banco conectado e trabalhos salvos online.");
  } catch (err) {
    console.error(err);
    bancoAtivo = false;
    trabalhos = localCarregar().map(normalizar);
    setDbStatus("Não foi possível conectar ao banco. Usando salvamento local.", false);
    desenhar();
  }
}

async function carregarDoBanco() {
  const { data, error } = await supabaseClient
    .from(TABLE)
    .select("id,titulo,integrantes,link,grupo,formato,descricao,criado_em")
    .order("criado_em", { ascending: false });
  if (error) throw error;
  trabalhos = (data || []).map(normalizar);
  desenhar();
}

async function migrarLocalSeNecessario() {
  if (!usuarioLogado || localStorage.getItem(MIGRATION_KEY)) return false;
  const locais = localCarregar().map(normalizar).filter(t => t.titulo && t.integrantes);
  if (!locais.length) {
    localStorage.setItem(MIGRATION_KEY, "1");
    return false;
  }
  const { count, error: countError } = await supabaseClient
    .from(TABLE)
    .select("id", { count: "exact", head: true });
  if (countError) return false;
  let enviou = false;
  if (count === 0) {
    const payload = locais.map(t => ({
      titulo: t.titulo,
      integrantes: t.integrantes,
      link: t.link || null,
      grupo: t.grupo || "Trabalho",
      formato: t.formato || "Trabalho",
      descricao: t.descricao || "Trabalho cadastrado pela turma."
    }));
    const { error } = await supabaseClient.from(TABLE).insert(payload);
    if (error) {
      console.warn("Migração local não concluída:", error);
      return false;
    }
    enviou = true;
  }
  localStorage.setItem(MIGRATION_KEY, "1");
  return enviou;
}

async function verificarSeEhAdmin(user) {
  if (!supabaseClient || !user) return null;
  try {
    const { data, error } = await supabaseClient.rpc("is_admin");
    if (error) {
      console.error("Falha ao verificar administrador:", error);
      return null;
    }
    return data ? user : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function sincronizarAdmin(user) {
  const minha = ++authSeq;
  const admin = await verificarSeEhAdmin(user);
  if (minha !== authSeq) return; // chegou uma resposta mais nova, ignora esta
  usuarioLogado = user;
  usuarioAdmin = admin;
  atualizarEstadoAdmin();
}

function exigirAdmin(acao) {
  if (usuarioAdmin) return true;
  abrirLoginModal(acao);
  return false;
}

function definirModoAuth(modo) {
  modoAuth = modo;
  const criar = modo === "criar";
  document.querySelectorAll(".auth-tab").forEach(b => b.classList.toggle("active", b.dataset.modo === modo));
  document.getElementById("loginTitulo").textContent = criar ? "Criar conta" : "Entrar";
  document.getElementById("loginIntroTitulo").textContent = criar ? "Crie sua conta" : "Entre na sua conta";
  document.getElementById("loginIntroTexto").textContent = criar
    ? "Com uma conta você pode adicionar trabalhos ao site."
    : "Contas de administrador também entram por aqui.";
  document.getElementById("loginSubmit").firstChild.textContent = criar ? "Criar conta " : "Entrar ";
  document.getElementById("loginPassword").autocomplete = criar ? "new-password" : "current-password";
}

function abrirLoginModal(acao = "entrar") {
  loginModal.dataset.acao = acao;
  definirModoAuth("entrar");
  if (acao === "adicionar trabalho") {
    document.getElementById("loginIntroTexto").textContent = "Para adicionar um trabalho, entre ou crie uma conta.";
  }
  loginModal.classList.add("open");
  loginModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setTimeout(() => document.getElementById("loginEmail")?.focus(), 50);
}

function fecharLoginModal() {
  loginModal.classList.remove("open");
  loginModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  loginForm.reset();
}

async function enviarAuth(e) {
  e.preventDefault();
  if (!bancoAtivo) {
    mostrarToast("Configure o Supabase primeiro.", "error");
    return;
  }
  const botao = document.getElementById("loginSubmit");
  const entrada = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const acao = loginModal.dataset.acao;
  if (modoAuth === "criar" && !usuarioValido(entrada)) {
    mostrarToast("Usuário: 3 a 30 letras, números, ponto, hífen ou _ (sem espaços).", "error");
    return;
  }
  const email = emailDeUsuario(entrada);
  botao.disabled = true;
  try {
    let usuario;
    if (modoAuth === "criar") {
      // A conta é criada por uma função do banco: já nasce confirmada, sem enviar e-mail
      // (assim não existe o erro "email rate limit exceeded").
      const { error } = await supabaseClient.rpc("criar_conta", { p_usuario: entrada, p_senha: password });
      if (error) {
        console.error(error);
        mostrarToast(error.message || "Não foi possível criar a conta.", "error");
        return;
      }
      const { data: dadosLogin, error: erroLogin } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (erroLogin) {
        console.error(erroLogin);
        mostrarToast("Conta criada! Agora entre pela aba Entrar.");
        definirModoAuth("entrar");
        return;
      }
      usuario = dadosLogin?.user;
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) {
        console.error("Erro de login Supabase:", error);
        const m = (error.message || "").toLowerCase();
        mostrarToast(m.includes("invalid login") ? "Usuário ou senha inválidos."
          : m.includes("not confirmed") ? "Conta não confirmada. Rode o supabase.sql de novo."
          : "Não foi possível entrar: " + error.message, "error");
        return;
      }
      usuario = data?.user;
    }
    await sincronizarAdmin(usuario);
    fecharLoginModal();
    mostrarToast(usuarioAdmin ? "Login de administrador realizado!" : (modoAuth === "criar" ? "Conta criada! Você já pode adicionar trabalhos." : "Bem-vindo(a)!"));
    if (acao === "adicionar trabalho") abrirAdicionarModal();
  } catch (err) {
    console.error(err);
    mostrarToast("Não foi possível continuar. Verifique a conexão e tente de novo.", "error");
  } finally {
    botao.disabled = false;
  }
}

async function sairAdmin() {
  if (!bancoAtivo) return;
  await supabaseClient.auth.signOut();
  usuarioLogado = null;
  usuarioAdmin = null;
  atualizarEstadoAdmin();
  mostrarToast("Você saiu da conta.");
}

function atualizarEstadoAdmin() {
  document.querySelectorAll(".admin-logout, .admin-manage").forEach(b => b.remove());
  if (abrirLogin) abrirLogin.hidden = !!usuarioLogado;
  const botaoCriar = document.getElementById("abrirCriarConta");
  if (botaoCriar) botaoCriar.hidden = !!usuarioLogado;
  document.body.classList.toggle("is-admin", !!usuarioAdmin);
  const barra = document.querySelector(".tools-row");
  if (!usuarioLogado || !barra) return;
  const sair = el("button", "admin-logout", "Sair");
  sair.type = "button";
  sair.addEventListener("click", sairAdmin);
  barra.prepend(sair);
  if (usuarioAdmin) {
    const painel = el("button", "admin-manage", "Painel admin");
    painel.type = "button";
    painel.addEventListener("click", abrirAdminsModal);
    barra.prepend(painel);
  }
}

async function carregarAdmins() {
  const lista = document.getElementById("listaAdmins");
  if (!lista) return;
  lista.innerHTML = '<div class="admin-empty">Carregando administradores...</div>';
  const { data, error } = await supabaseClient.rpc("list_admins");
  if (error) {
    console.error(error);
    lista.innerHTML = '<div class="admin-empty">Não foi possível carregar os administradores.</div>';
    return;
  }
  lista.innerHTML = "";
  (data || []).forEach(admin => {
    const row = el("div", "admin-row");
    const info = el("div", "admin-row-info", "", [
      el("strong", "", nomeDeUsuario(admin.email)),
      el("span", "", admin.ativo ? "Administrador ativo" : "Desativado")
    ]);
    const remover = el("button", "admin-remove", "Remover");
    remover.type = "button";
    remover.disabled = admin.email.toLowerCase() === (usuarioAdmin?.email || "").toLowerCase();
    remover.title = remover.disabled ? "Você não pode remover o próprio acesso por aqui." : "Remover administrador";
    remover.addEventListener("click", () => removerAdmin(admin.email));
    row.append(info, remover);
    lista.appendChild(row);
  });
  if (!data?.length) lista.innerHTML = '<div class="admin-empty">Nenhum administrador cadastrado.</div>';
}

function abrirAdminsModal() {
  if (!exigirAdmin("gerenciar administradores")) return;
  const m = document.getElementById("adminsModal");
  m.classList.add("open");
  m.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  carregarAdmins();
  setTimeout(() => document.getElementById("novoAdminEmail")?.focus(), 50);
}

function fecharAdminsModal() {
  const m = document.getElementById("adminsModal");
  if (!m) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  document.getElementById("adminForm")?.reset();
}

async function adicionarAdmin(e) {
  e.preventDefault();
  if (salvando || !exigirAdmin("gerenciar administradores")) return;
  const input = document.getElementById("novoAdminEmail");
  const inputSenha = document.getElementById("novoAdminSenha");
  const digitado = input.value.trim();
  const senha = inputSenha.value;
  if (!digitado) return;
  if (!digitado.includes("@") && !usuarioValido(digitado)) {
    mostrarToast("Usuário: 3 a 30 letras, números, ponto, hífen ou _ (sem espaços).", "error");
    return;
  }
  const email = emailDeUsuario(digitado);
  salvando = true;
  try {
    let jaTinhaConta = false;
    if (senha) {
      if (digitado.includes("@")) {
        mostrarToast("Para criar a conta com senha, use um nome de usuário (sem @).", "error");
        return;
      }
      const { error } = await supabaseClient.rpc("criar_conta", { p_usuario: digitado, p_senha: senha });
      if (error && /já existe/i.test(error.message || "")) jaTinhaConta = true;
      else if (error) {
        console.error(error);
        mostrarToast(error.message || "Não foi possível criar a conta.", "error");
        return;
      }
    }
    const { error } = await supabaseClient.rpc("add_admin", { p_email: email });
    if (error) {
      console.error(error);
      mostrarToast(error.message || "Não foi possível adicionar o administrador.", "error");
      return;
    }
    mostrarToast(jaTinhaConta ? "Essa pessoa já tinha conta e agora é administradora." : senha ? "Conta de administrador criada!" : "Administrador adicionado!");
    input.value = "";
    inputSenha.value = "";
    carregarAdmins();
  } finally {
    salvando = false;
  }
}

async function removerAdmin(email) {
  if (!exigirAdmin("gerenciar administradores")) return;
  if (email.toLowerCase() === (usuarioAdmin?.email || "").toLowerCase()) {
    mostrarToast("Você não pode remover o próprio acesso.", "error");
    return;
  }
  if (!confirm(`Remover ${email} da lista de administradores?`)) return;
  const { error } = await supabaseClient.rpc("remove_admin", { p_email: email });
  if (error) {
    console.error(error);
    mostrarToast(error.message || "Não foi possível remover o administrador.", "error");
    return;
  }
  mostrarToast("Administrador removido.");
  carregarAdmins();
}

function soltarConfetes() {
  if (!confettiContainer || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  confettiContainer.innerHTML = "";
  const formas = ["square", "circle", "diamond"];
  for (let i = 0; i < 42; i++) {
    const confete = document.createElement("span");
    confete.className = `confetti ${formas[i % formas.length]}`;
    confete.style.left = `${8 + Math.random() * 84}%`;
    confete.style.setProperty("--x", `${(Math.random() - 0.5) * 180}px`);
    confete.style.setProperty("--delay", `${Math.random() * 180}ms`);
    confete.style.setProperty("--duration", `${850 + Math.random() * 750}ms`);
    confete.style.setProperty("--rotate", `${Math.random() * 720 - 360}deg`);
    confettiContainer.appendChild(confete);
  }
  setTimeout(() => { confettiContainer.innerHTML = ""; }, 1900);
}

function abrirTrabalho(t, index = 0) {
  const accent = ["#c4170c", "#d35b18", "#9d3a2f", "#b51f18", "#7f3029", "#d04a3b"][index % 6];
  document.getElementById("modalIcon").textContent = "✦";
  document.getElementById("modalHead").style.setProperty("--modal-accent", accent);
  document.getElementById("modalKicker").textContent = "Trabalho";
  document.getElementById("modalTitulo").textContent = t.titulo;
  document.getElementById("modalDescricao").textContent = t.descricao || "Trabalho cadastrado pela turma.";
  document.getElementById("modalInfo").replaceChildren(
    el("div", "info-item", "", [el("span", "info-label", "Alunos"), el("strong", "", t.integrantes)]),
    el("div", "info-item", "", [el("span", "info-label", "Link"), el("strong", "", t.link ? "Disponível" : "Não informado")])
  );
  const link = document.getElementById("modalLink");
  if (t.link) { link.hidden = false; link.href = t.link; } else link.hidden = true;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  document.querySelector("#modal .modal-close").focus();
}

function fecharModal() {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function abrirAdicionarModal() {
  if (bancoAtivo && !usuarioLogado) { abrirLoginModal("adicionar trabalho"); return; }
  indiceEditando = null;
  adicionarModal.classList.remove("edit-mode");
  document.getElementById("adicionarTitulo").textContent = "Adicionar trabalho";
  document.getElementById("formModalKicker").textContent = "Novo trabalho";
  document.getElementById("submitTrabalho").innerHTML = 'Adicionar trabalho <span>→</span>';
  formAdicionar.reset();
  adicionarModal.classList.add("open");
  adicionarModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setTimeout(() => document.getElementById("novoTitulo").focus(), 50);
}

function abrirEditarModal(index) {
  if (!exigirAdmin("editar")) return;
  const t = trabalhos[index];
  if (!t) return;
  indiceEditando = index;
  adicionarModal.classList.add("edit-mode");
  document.getElementById("adicionarTitulo").textContent = "Editar trabalho";
  document.getElementById("formModalKicker").textContent = "Editar cadastro";
  document.getElementById("submitTrabalho").innerHTML = 'Salvar alterações <span>✓</span>';
  document.getElementById("novoTitulo").value = t.titulo || "";
  document.getElementById("novosAlunos").value = t.integrantes || "";
  document.getElementById("novoLink").value = t.link || "";
  adicionarModal.classList.add("open");
  adicionarModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setTimeout(() => document.getElementById("novoTitulo").focus(), 50);
}

function abrirRemoverModal(index) {
  if (!exigirAdmin("remover")) return;
  const t = trabalhos[index];
  if (!t) return;
  indiceRemovendo = index;
  document.getElementById("removerTitulo").textContent = t.titulo || "Trabalho sem título";
  document.getElementById("removerAlunos").textContent = t.integrantes || "Alunos não informados";
  removerModal.classList.add("open");
  removerModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setTimeout(() => confirmarRemocao.focus(), 50);
}

function fecharRemoverModal() {
  removerModal.classList.remove("open");
  removerModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  indiceRemovendo = null;
}

async function removerTrabalho() {
  if (salvando || indiceRemovendo === null || !trabalhos[indiceRemovendo]) return;
  if (!exigirAdmin("remover")) return;
  const t = trabalhos[indiceRemovendo];
  salvando = true;
  try {
    if (bancoAtivo) {
      // .select("id") devolve as linhas apagadas: se vier vazio, o servidor recusou (sem permissão).
      const { data, error } = await supabaseClient.from(TABLE).delete().eq("id", t.id).select("id");
      if (error) { console.error(error); mostrarToast("Não foi possível remover o trabalho.", "error"); return; }
      if (!data?.length) { fecharRemoverModal(); sessaoExpirou(); return; }
      await carregarDoBanco();
    } else {
      trabalhos.splice(indiceRemovendo, 1);
      localSalvar();
      desenhar();
    }
    fecharRemoverModal();
    mostrarToast("Trabalho removido com sucesso!");
  } finally {
    salvando = false;
  }
}

function fecharAdicionarModal() {
  adicionarModal.classList.remove("open");
  adicionarModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  indiceEditando = null;
}

document.querySelectorAll("[data-close-modal]").forEach(btn => btn.addEventListener("click", fecharModal));
document.querySelectorAll("[data-close-add]").forEach(btn => btn.addEventListener("click", fecharAdicionarModal));
document.querySelectorAll("[data-close-remove]").forEach(btn => btn.addEventListener("click", fecharRemoverModal));
document.querySelectorAll("[data-close-login]").forEach(btn => btn.addEventListener("click", fecharLoginModal));
document.querySelectorAll("[data-close-admins]").forEach(btn => btn.addEventListener("click", fecharAdminsModal));
confirmarRemocao.addEventListener("click", removerTrabalho);
abrirAdicionar.addEventListener("click", abrirAdicionarModal);
abrirLogin?.addEventListener("click", () => abrirLoginModal("entrar"));
document.getElementById("abrirCriarConta")?.addEventListener("click", () => { abrirLoginModal("entrar"); definirModoAuth("criar"); });
loginForm.addEventListener("submit", enviarAuth);
document.querySelectorAll(".auth-tab").forEach(b => b.addEventListener("click", () => definirModoAuth(b.dataset.modo)));
document.getElementById("adminForm")?.addEventListener("submit", adicionarAdmin);

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (modal.classList.contains("open")) fecharModal();
    if (adicionarModal.classList.contains("open")) fecharAdicionarModal();
    if (removerModal.classList.contains("open")) fecharRemoverModal();
    if (loginModal.classList.contains("open")) fecharLoginModal();
    if (document.getElementById("adminsModal")?.classList.contains("open")) fecharAdminsModal();
  }
});

formAdicionar.addEventListener("submit", async e => {
  e.preventDefault();
  if (salvando) return;
  if (bancoAtivo && !usuarioLogado) { fecharAdicionarModal(); abrirLoginModal("adicionar trabalho"); return; }
  const titulo = document.getElementById("novoTitulo").value.trim();
  const alunos = document.getElementById("novosAlunos").value.trim();
  const linkDigitado = document.getElementById("novoLink").value.trim();
  if (!titulo || !alunos) return;

  const link = urlSegura(linkDigitado);
  if (linkDigitado && !link) {
    mostrarToast("O link precisa começar com http:// ou https://", "error");
    return;
  }

  const atual = indiceEditando !== null ? trabalhos[indiceEditando] : null;
  const estavaEditando = !!atual;
  if (estavaEditando && !exigirAdmin("editar")) return;

  // Ao editar, mantém grupo, formato e descrição que o trabalho já tinha.
  const payload = {
    titulo,
    integrantes: alunos,
    link: link || null,
    grupo: atual?.grupo || `Trabalho ${proximoNumero()}`,
    formato: atual?.formato || "Trabalho",
    descricao: atual?.descricao || "Trabalho cadastrado pela turma."
  };

  const botao = document.getElementById("submitTrabalho");
  salvando = true;
  botao.disabled = true;
  try {
    if (bancoAtivo) {
      let resposta;
      if (estavaEditando) {
        resposta = await supabaseClient.from(TABLE).update(payload).eq("id", atual.id).select("id");
        if (!resposta.error && !resposta.data?.length) { sessaoExpirou(); return; }
      } else {
        resposta = await supabaseClient.from(TABLE).insert(payload);
      }
      if (resposta.error?.code === "42501") { sessaoExpirou(); return; }
      if (resposta.error) {
        console.error(resposta.error);
        mostrarToast("Não foi possível salvar no banco de dados.", "error");
        return;
      }
      await carregarDoBanco();
    } else {
      if (estavaEditando) Object.assign(atual, payload);
      else trabalhos.push(normalizar(payload));
      localSalvar();
      desenhar();
    }

    formAdicionar.reset();
    fecharAdicionarModal();
    document.getElementById("trabalhos").scrollIntoView({ behavior: "smooth", block: "start" });
    if (estavaEditando) mostrarToast("Trabalho editado com sucesso!");
    else { mostrarToast("Trabalho adicionado com sucesso!"); soltarConfetes(); }
  } finally {
    salvando = false;
    botao.disabled = false;
  }
});

function criarAcoes(t) {
  const acoes = el("div", "card-actions");
  const editar = el("button", "edit-btn", "Editar");
  const remover = el("button", "remove-btn", "Remover");
  editar.type = "button"; remover.type = "button";
  editar.title = "Editar trabalho"; remover.title = "Remover trabalho";
  editar.addEventListener("click", e => { e.stopPropagation(); abrirEditarModal(trabalhos.indexOf(t)); });
  remover.addEventListener("click", e => { e.stopPropagation(); abrirRemoverModal(trabalhos.indexOf(t)); });
  acoes.append(editar, remover);
  return acoes;
}

function card(t, index) {
  const c = el("article", "card");
  c.style.setProperty("--delay", `${Math.min(index * 55, 330)}ms`);
  c.style.setProperty("--accent", ["#c4170c", "#d35b18", "#9d3a2f", "#b51f18", "#7f3029", "#d04a3b"][index % 6]);
  c.tabIndex = 0; c.setAttribute("role", "button"); c.setAttribute("aria-label", `Abrir detalhes de ${t.titulo}`);
  c.appendChild(el("div", "card-top", "", [el("span", "format-tag", "Trabalho"), el("span", "card-arrow", "↗")]));
  c.appendChild(el("div", "card-icon", "✦"));
  c.appendChild(el("h3", "", t.titulo));
  c.appendChild(el("p", "", t.descricao || "Trabalho cadastrado pela turma."));
  const footer = el("div", "card-footer");
  footer.appendChild(el("span", "group", t.integrantes)); footer.appendChild(criarAcoes(t)); c.appendChild(footer);
  c.addEventListener("click", () => abrirTrabalho(t, index));
  c.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrirTrabalho(t, index); } });
  return c;
}

function destaque(t, index) {
  const c = el("article", "destaque"); c.style.setProperty("--accent", "#c4170c");
  c.appendChild(el("div", "featured-glow")); c.appendChild(el("div", "featured-icon", "✦"));
  c.appendChild(el("div", "featured-content", "", [el("span", "featured-label", "Trabalho em destaque"), el("h2", "", t.titulo), el("p", "", t.descricao || "Trabalho cadastrado pela turma."), el("div", "featured-meta", "", [el("span", "", t.integrantes)])]));
  const actions = el("div", "featured-actions"); const btn = el("button", "featured-button", "Ver detalhes →"); btn.type="button";
  btn.addEventListener("click", e => { e.stopPropagation(); abrirTrabalho(t,index); }); actions.appendChild(btn); actions.appendChild(criarAcoes(t)); c.appendChild(actions); return c;
}

function listaFiltrada() {
  const q = semAcento(campo.value.trim());
  if (!q) return trabalhos;
  return trabalhos.filter(t => semAcento([t.titulo, t.integrantes, t.descricao, t.grupo, t.formato].join(" ")).includes(q));
}

function estadoVazio() {
  return el("div", "vazio", "", [el("div", "empty-icon", "＋"), el("h3", "", "Nenhum trabalho adicionado ainda"), el("p", "", "Clique em “Adicionar trabalho” para cadastrar o primeiro trabalho da turma."), (()=>{const b=el("button","empty-add-btn","＋ Adicionar primeiro trabalho");b.type="button";b.addEventListener("click",abrirAdicionarModal);return b;})()]);
}

function desenhar() {
  const lista = listaFiltrada(); raiz.replaceChildren();
  document.getElementById("statsMini").textContent = `${trabalhos.length} ${trabalhos.length === 1 ? "trabalho" : "trabalhos"} cadastrado${trabalhos.length === 1 ? "" : "s"}`;
  if (campo.value.trim()) {
    raiz.appendChild(el("div","results-head","",[el("h2","secao-title",`${lista.length} ${lista.length===1?"resultado":"resultados"}`),el("span","results-filter","Pesquisa")]));
    if(lista.length) raiz.appendChild(el("div","grid","",lista.map((t,i)=>card(t,i)))); else raiz.appendChild(el("div","vazio","",[el("div","empty-icon","⌕"),el("h3","","Nada encontrado"),el("p","","Tente outra palavra ou pesquise pelo nome dos alunos ou trabalho.")])); return;
  }
  if(!trabalhos.length){raiz.appendChild(estadoVazio());return;}
  const [a,...resto]=trabalhos;
  if(a) raiz.appendChild(el("div","portal","",[destaque(a,0)]));
  if(resto.length){raiz.appendChild(el("div","section-heading","",[el("div","","",[el("span","section-label","Trabalhos cadastrados"),el("h2","secao-title","Todos os outros trabalhos")]),el("span","section-count",`${resto.length} ${resto.length===1?"disponível":"disponíveis"}`)])); raiz.appendChild(el("div","grid","",resto.map((t,i)=>card(t,i+1))));}
}

campo.addEventListener("input", desenhar);
limparBusca.addEventListener("click",()=>{campo.value="";desenhar();campo.focus();});

// Começa buscando no banco assim que o site abre.
iniciarBanco();
