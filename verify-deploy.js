#!/usr/bin/env node

/**
 * Script de verificação pré-deploy para Vercel
 * Verifica se todas as configurações estão corretas
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 Verificando configuração para deploy na Vercel...\n');

let hasErrors = false;
let warnings = [];

// 1. Verificar se vercel.json existe
console.log('1️⃣  Verificando vercel.json...');
if (fs.existsSync('vercel.json')) {
  console.log('   ✅ vercel.json encontrado');
  try {
    const vercelConfig = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
    if (!vercelConfig.builds || !vercelConfig.routes) {
      console.log('   ⚠️  vercel.json pode estar incompleto');
      warnings.push('vercel.json não contém builds ou routes');
    }
  } catch (e) {
    console.log('   ❌ Erro ao ler vercel.json:', e.message);
    hasErrors = true;
  }
} else {
  console.log('   ❌ vercel.json não encontrado');
  hasErrors = true;
}

// 2. Verificar package.json
console.log('\n2️⃣  Verificando package.json...');
if (fs.existsSync('package.json')) {
  console.log('   ✅ package.json encontrado');
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    
    if (!pkg.scripts || !pkg.scripts.start) {
      console.log('   ⚠️  Script "start" não encontrado');
      warnings.push('Adicione script "start" no package.json');
    } else {
      console.log('   ✅ Script "start" encontrado');
    }

    // Verificar dependências essenciais
    const requiredDeps = ['express', 'postgres', 'dotenv', 'bcrypt', 'nodemailer'];
    const missingDeps = requiredDeps.filter(dep => 
      !pkg.dependencies || !pkg.dependencies[dep]
    );
    
    if (missingDeps.length > 0) {
      console.log('   ❌ Dependências faltando:', missingDeps.join(', '));
      hasErrors = true;
    } else {
      console.log('   ✅ Todas as dependências essenciais presentes');
    }
  } catch (e) {
    console.log('   ❌ Erro ao ler package.json:', e.message);
    hasErrors = true;
  }
} else {
  console.log('   ❌ package.json não encontrado');
  hasErrors = true;
}

// 3. Verificar index.js
console.log('\n3️⃣  Verificando index.js...');
if (fs.existsSync('index.js')) {
  console.log('   ✅ index.js encontrado');
  const indexContent = fs.readFileSync('index.js', 'utf8');
  
  // Verificar se exporta o app
  if (indexContent.includes('module.exports = app')) {
    console.log('   ✅ App está sendo exportado (module.exports)');
  } else if (indexContent.includes('export default app')) {
    console.log('   ✅ App está sendo exportado (ES6)');
  } else {
    console.log('   ⚠️  App pode não estar sendo exportado corretamente');
    warnings.push('Certifique-se de exportar o app no index.js');
  }
  
  // Verificar listen condicional
  if (indexContent.includes('process.env.NODE_ENV') && indexContent.includes('app.listen')) {
    console.log('   ✅ app.listen() está condicional');
  } else if (indexContent.includes('app.listen')) {
    console.log('   ⚠️  app.listen() pode não estar condicional');
    warnings.push('Considere tornar app.listen() condicional (apenas em dev)');
  }
  
  // Verificar uso de variáveis de ambiente
  if (indexContent.includes('process.env.DATABASE_URL')) {
    console.log('   ✅ Usando variáveis de ambiente');
  }
} else {
  console.log('   ❌ index.js não encontrado');
  hasErrors = true;
}

// 4. Verificar .env.example
console.log('\n4️⃣  Verificando .env.example...');
if (fs.existsSync('.env.example')) {
  console.log('   ✅ .env.example encontrado');
} else {
  console.log('   ⚠️  .env.example não encontrado (recomendado)');
  warnings.push('Crie .env.example com as variáveis necessárias');
}

// 5. Verificar .gitignore
console.log('\n5️⃣  Verificando .gitignore...');
if (fs.existsSync('.gitignore')) {
  console.log('   ✅ .gitignore encontrado');
  const gitignoreContent = fs.readFileSync('.gitignore', 'utf8');
  
  const requiredIgnores = ['.env', 'node_modules', '.vercel'];
  const missingIgnores = requiredIgnores.filter(pattern => 
    !gitignoreContent.includes(pattern)
  );
  
  if (missingIgnores.length > 0) {
    console.log('   ⚠️  Padrões faltando no .gitignore:', missingIgnores.join(', '));
    warnings.push('Adicione ao .gitignore: ' + missingIgnores.join(', '));
  } else {
    console.log('   ✅ .gitignore contém padrões essenciais');
  }
} else {
  console.log('   ⚠️  .gitignore não encontrado');
  warnings.push('Crie .gitignore para proteger arquivos sensíveis');
}

// 6. Verificar se .env está no .gitignore
console.log('\n6️⃣  Verificando segurança de .env...');
if (fs.existsSync('.env')) {
  const gitignore = fs.existsSync('.gitignore') 
    ? fs.readFileSync('.gitignore', 'utf8') 
    : '';
  
  if (gitignore.includes('.env')) {
    console.log('   ✅ .env está protegido no .gitignore');
  } else {
    console.log('   ❌ CRÍTICO: .env não está no .gitignore!');
    hasErrors = true;
  }
}

// 7. Verificar tamanho do projeto
console.log('\n7️⃣  Verificando tamanho do projeto...');
try {
  const { execSync } = require('child_process');
  const du = execSync('du -sh . 2>/dev/null || echo "N/A"').toString().trim();
  console.log('   📦 Tamanho aproximado:', du);
  console.log('   ℹ️  Limite Vercel: 250 MB (sem node_modules)');
} catch (e) {
  console.log('   ⚠️  Não foi possível calcular tamanho');
}

// Resumo
console.log('\n' + '='.repeat(60));
console.log('📊 RESUMO DA VERIFICAÇÃO');
console.log('='.repeat(60));

if (hasErrors) {
  console.log('\n❌ ERROS ENCONTRADOS - Corrija antes de fazer deploy!');
  process.exit(1);
} else if (warnings.length > 0) {
  console.log('\n⚠️  AVISOS (' + warnings.length + ')');
  warnings.forEach((w, i) => {
    console.log(`   ${i + 1}. ${w}`);
  });
  console.log('\n✅ Nenhum erro crítico, mas considere os avisos acima');
} else {
  console.log('\n✅ TUDO CERTO! Pronto para deploy na Vercel! 🚀');
}

console.log('\n📝 Próximos passos:');
console.log('   1. git add .');
console.log('   2. git commit -m "feat: configurar para Vercel"');
console.log('   3. git push origin main');
console.log('   4. Importar projeto em vercel.com');
console.log('   5. Configurar variáveis de ambiente');
console.log('\n💡 Ou use: vercel --prod\n');

process.exit(warnings.length > 0 ? 0 : 0);
