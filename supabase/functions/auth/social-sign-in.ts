import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.0";
import { load } from "https://deno.land/std@0.223.0/dotenv/mod.ts";

// Carregar variáveis de ambiente - importante para segredos, se houver lógica Facebook mais complexa
const env = await load();
const FACEBOOK_APP_ID = env["FACEBOOK_APP_ID"];
const FACEBOOK_APP_SECRET = env["FACEBOOK_APP_SECRET"];
// Para Apple, se precisar de validação mais complexa ou tokens de servidor
const APPLE_AUDIENCE = env["APPLE_AUDIENCE"]; // Seu bundle ID

// Inicializar cliente Supabase com service_role key para acesso administrativo
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { provider, token } = await req.json();

    if (!provider || !token) {
      return new Response("Missing provider or token", { status: 400 });
    }

    let session;
    let error;

    switch (provider) {
      case "google":
      case "apple":
        // Supabase Auth Admin pode lidar diretamente com id_tokens (JWT) do Google e Apple
        const { data: idTokenData, error: idTokenError } =
          await supabaseAdmin.auth.signInWithIdToken({
            provider: provider, // 'google' ou 'apple'
            token: token, // O id_token JWT
          });
        session = idTokenData?.session;
        error = idTokenError;
        break;

      case "facebook":
        // === Lógica para Facebook ===
        // O Facebook retorna um access_token, não um id_token JWT.
        // Precisamos usar este access_token para obter informações do usuário no Facebook
        // e então criar/autenticar o usuário no Supabase manualmente.
        // Ou, se você tem uma maneira de gerar um ID token JWT válido para o Facebook, use-o.
        //
        // Exemplo de como obter dados do usuário do Facebook:
        const fbGraphResponse = await fetch(
          `https://graph.facebook.com/me?fields=id,name,email&access_token=${token}`,
        );
        if (!fbGraphResponse.ok) {
          console.error(
            "Erro ao buscar dados do Facebook:",
            await fbGraphResponse.text(),
          );
          return new Response("Erro ao autenticar com Facebook.", {
            status: 400,
          });
        }
        const fbUserData = await fbGraphResponse.json();

        if (!fbUserData.email) {
          return new Response(
            "Email não disponível no Facebook. Permissões insuficientes ou usuário não forneceu.",
            { status: 400 },
          );
        }

        // Tentar encontrar um usuário existente pelo email
        const { data: existingUsers, error: usersError } =
          await supabaseAdmin.auth.admin.listUsers({
            email: fbUserData.email,
          });

        let userIdToUse: string;
        if (usersError) throw usersError;

        if (existingUsers?.users.length > 0) {
          // Usuário existe, atualizar ou vincular
          userIdToUse = existingUsers.users[0].id;
          // Poderia-se adicionar lógica para vincular a conta social aqui, se usando `user_social_accounts`
          // No entanto, para fins de login, vamos apenas criar uma sessão para ele.
        } else {
          // Usuário novo, criar
          const { data: newUser, error: createUserError } =
            await supabaseAdmin.auth.admin.createUser({
              email: fbUserData.email,
              email_confirm: true, // Se quiser que o email já seja considerado confirmado
              user_metadata: {
                full_name: fbUserData.name,
                provider: "facebook",
                provider_id: fbUserData.id,
              },
            });
          if (createUserError) throw createUserError;
          userIdToUse = newUser!.user!.id;
        }

        // Criar uma sessão para o usuário (novo ou existente)
        const { data: fbSessionData, error: fbSessionError } =
          await supabaseAdmin.auth.admin.createSession(userIdToUse);
        session = fbSessionData?.session;
        error = fbSessionError;

        break;

      default:
        return new Response("Invalid social provider", { status: 400 });
    }

    if (error) {
      console.error(
        `Erro na autenticação social (${provider}):`,
        error.message,
      );
      return new Response(`Erro ao autenticar: ${error.message}`, {
        status: 500,
      });
    }

    if (!session) {
      return new Response("Sessão Supabase não gerada.", { status: 500 });
    }

    return new Response(
      JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
        token_type: session.token_type,
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (error: any) {
    console.error("Erro inesperado na Edge Function de social sign-in:", error);
    return new Response(
      JSON.stringify({ message: error.message || "Erro interno do servidor" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
