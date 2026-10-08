-- =====================================================
-- BANCO DE DADOS — TRABALHOS EMOÇÕES
-- Rode este SQL no SQL Editor do seu projeto Supabase.
--
-- O sistema usa Supabase Auth + tabela admins.
-- IMPORTANTE: não coloque senhas neste arquivo.
--
-- SEGURANÇA (no painel do Supabase, em Authentication):
--  * As contas (usuário + senha) são criadas pela função criar_conta(), no fim
--    deste arquivo. Ela não envia e-mail, então NÃO existe limite de e-mails e
--    não importa se "Confirm email" está ligado ou desligado.
--  * Opcional e recomendado: desligue "Allow new users to sign up" em
--    Authentication, para que só criar_conta() consiga abrir contas.
--  * NÃO publique este arquivo junto com o site: ele contém a senha inicial.
-- =====================================================

create table if not exists public.trabalhos (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  integrantes text not null,
  link text,
  grupo text not null default 'Trabalho',
  formato text not null default 'Trabalho',
  descricao text not null default 'Trabalho cadastrado pela turma.',
  criado_em timestamptz not null default now()
);

alter table public.trabalhos enable row level security;

-- =====================================================
-- VALIDAÇÃO DOS DADOS
-- Impede textos gigantes e links perigosos ("javascript:", "data:" etc.),
-- mesmo que alguém envie dados direto para a API, sem passar pelo site.
-- =====================================================
-- Limpa links antigos que não começam com http:// ou https://
update public.trabalhos set link = null
where link is not null and link !~* '^https?://';

alter table public.trabalhos drop constraint if exists trabalhos_titulo_tamanho;
alter table public.trabalhos add constraint trabalhos_titulo_tamanho
  check (char_length(titulo) between 1 and 120) not valid;

alter table public.trabalhos drop constraint if exists trabalhos_integrantes_tamanho;
alter table public.trabalhos add constraint trabalhos_integrantes_tamanho
  check (char_length(integrantes) between 1 and 250) not valid;

alter table public.trabalhos drop constraint if exists trabalhos_link_valido;
alter table public.trabalhos add constraint trabalhos_link_valido
  check (link is null or (char_length(link) <= 2000 and link ~* '^https?://')) not valid;

alter table public.trabalhos drop constraint if exists trabalhos_grupo_tamanho;
alter table public.trabalhos add constraint trabalhos_grupo_tamanho
  check (char_length(grupo) <= 80) not valid;

alter table public.trabalhos drop constraint if exists trabalhos_formato_tamanho;
alter table public.trabalhos add constraint trabalhos_formato_tamanho
  check (char_length(formato) <= 60) not valid;

alter table public.trabalhos drop constraint if exists trabalhos_descricao_tamanho;
alter table public.trabalhos add constraint trabalhos_descricao_tamanho
  check (char_length(descricao) <= 500) not valid;

-- =====================================================
-- ADMINISTRADORES
-- =====================================================
create table if not exists public.admins (
  email text primary key,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

alter table public.admins enable row level security;

-- Ninguém acessa a tabela admins diretamente pelo navegador.
revoke all on table public.admins from anon, authenticated;

-- =====================================================
-- FUNÇÃO: verificar se o usuário logado é administrador
-- =====================================================
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and ativo = true
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- =====================================================
-- FUNÇÃO: listar administradores
-- =====================================================
create or replace function public.list_admins()
returns table (
  email text,
  ativo boolean,
  criado_em timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  return query
    select a.email, a.ativo, a.criado_em
    from public.admins a
    order by a.criado_em asc;
end;
$$;

-- O Postgres libera funções para todos por padrão; aqui tiramos de quem não está logado.
revoke execute on function public.list_admins() from public, anon;
grant execute on function public.list_admins() to authenticated;

-- =====================================================
-- FUNÇÃO: adicionar administrador
-- A conta precisa existir no Supabase Auth para conseguir fazer login.
-- =====================================================
create or replace function public.add_admin(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  email_limpo text := lower(trim(p_email));
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  if email_limpo is null or email_limpo = '' or position('@' in email_limpo) < 2 then
    raise exception 'Informe um e-mail válido.';
  end if;

  insert into public.admins (email, ativo)
  values (email_limpo, true)
  on conflict (email) do update set ativo = true;

  return true;
end;
$$;

-- O Postgres libera funções para todos por padrão; aqui tiramos de quem não está logado.
revoke execute on function public.add_admin(text) from public, anon;
grant execute on function public.add_admin(text) to authenticated;

-- =====================================================
-- FUNÇÃO: remover administrador
-- O próprio usuário não pode remover o próprio acesso pelo painel.
-- =====================================================
create or replace function public.remove_admin(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  email_limpo text := lower(trim(p_email));
  meu_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  if email_limpo = meu_email then
    raise exception 'Você não pode remover o próprio acesso.';
  end if;

  delete from public.admins where lower(email) = email_limpo;
  return true;
end;
$$;

-- O Postgres libera funções para todos por padrão; aqui tiramos de quem não está logado.
revoke execute on function public.remove_admin(text) from public, anon;
grant execute on function public.remove_admin(text) to authenticated;

-- =====================================================
-- POLÍTICAS DA TABELA TRABALHOS
-- =====================================================
drop policy if exists "Trabalhos podem ser vistos por todos" on public.trabalhos;
drop policy if exists "Qualquer pessoa pode cadastrar trabalho" on public.trabalhos;
drop policy if exists "Contas logadas podem cadastrar trabalho" on public.trabalhos;
drop policy if exists "Administrador pode editar trabalhos" on public.trabalhos;
drop policy if exists "Administrador pode remover trabalhos" on public.trabalhos;

create policy "Trabalhos podem ser vistos por todos"
on public.trabalhos
for select
to anon, authenticated
using (true);

-- Só quem tem conta (logado) pode adicionar trabalho.
create policy "Contas logadas podem cadastrar trabalho"
on public.trabalhos
for insert
to authenticated
with check (true);

create policy "Administrador pode editar trabalhos"
on public.trabalhos
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Administrador pode remover trabalhos"
on public.trabalhos
for delete
to authenticated
using (public.is_admin());

-- Permissões mínimas para o cliente web.
revoke insert on public.trabalhos from anon;
grant select on public.trabalhos to anon;
grant select, insert, update, delete on public.trabalhos to authenticated;

-- =====================================================
-- PRIMEIRO ADMINISTRADOR
--
-- Depois de criar este banco, coloque aqui o e-mail da conta
-- que já existe em Authentication > Users.
--
-- O administrador que já estava usando o site foi incluído abaixo.
insert into public.admins (email, ativo)
values ('portemanuel1951@gmail.com', true)
on conflict (email) do update set ativo = true;
-- =====================================================

-- =====================================================
-- CRIAR CONTA (usuário + senha) SEM ENVIAR E-MAIL
-- O site chama esta função no botão "Criar conta". A conta já nasce confirmada.
-- O domínio '@emocoes.app' abaixo deve ser igual a usuarioDominio no
-- supabase-config.js.
-- =====================================================
create extension if not exists pgcrypto with schema extensions;

create or replace function public.criar_conta(p_usuario text, p_senha text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  usuario text := lower(trim(coalesce(p_usuario, '')));
  email_interno text;
  novo_id uuid := gen_random_uuid();
  coluna text;
begin
  if usuario !~ '^[a-z0-9._-]{3,30}$' then
    raise exception 'Usuário inválido: use de 3 a 30 letras, números, ponto, hífen ou _.';
  end if;
  if p_senha is null or char_length(p_senha) < 6 then
    raise exception 'A senha precisa ter pelo menos 6 caracteres.';
  end if;

  email_interno := usuario || '@emocoes.app';
  if exists (select 1 from auth.users where lower(email) = email_interno) then
    raise exception 'Este usuário já existe.';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', novo_id, 'authenticated', 'authenticated', email_interno,
    extensions.crypt(p_senha, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{}', now(), now()
  );

  -- Estas colunas não podem ficar NULL, senão o login falha com "Database error querying schema".
  foreach coluna in array array['confirmation_token', 'recovery_token', 'email_change_token_new', 'email_change',
    'email_change_token_current', 'phone_change', 'phone_change_token', 'reauthentication_token'] loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'auth' and table_name = 'users' and column_name = coluna) then
      execute format('update auth.users set %1$I = coalesce(%1$I, '''') where id = $1', coluna) using novo_id;
    end if;
  end loop;

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (
    gen_random_uuid(), novo_id, novo_id::text,
    jsonb_build_object('sub', novo_id::text, 'email', email_interno, 'email_verified', true),
    'email', now(), now(), now()
  );
  return true;
end;
$$;

revoke execute on function public.criar_conta(text, text) from public;
grant execute on function public.criar_conta(text, text) to anon, authenticated;

-- =====================================================
-- CONTA DO ADMINISTRADOR "Emanuel"
-- Usuário: Emanuel    Senha: md151083    (troque depois do primeiro login)
-- A conta é APAGADA E CRIADA DE NOVO sempre que este arquivo roda, para consertar
-- qualquer conta antiga estragada ou criada com outra senha.
-- ATENÇÃO: rodar de novo volta a senha dele para md151083.
-- =====================================================
delete from auth.identities
where user_id in (select id from auth.users where lower(email) = 'emanuel@emocoes.app');
delete from auth.users where lower(email) = 'emanuel@emocoes.app';

select public.criar_conta('emanuel', 'md151083');

insert into public.admins (email, ativo)
values ('emanuel@emocoes.app', true)
on conflict (email) do update set ativo = true;

-- Conferência: deve aparecer 1 linha com confirmado = true e admin = true.
select u.email,
       u.email_confirmed_at is not null as confirmado,
       exists (select 1 from public.admins a where lower(a.email) = lower(u.email) and a.ativo) as admin
from auth.users u
where lower(u.email) = 'emanuel@emocoes.app';
