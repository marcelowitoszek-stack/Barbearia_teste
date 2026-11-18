
Usuário: marta.marques@cristolandiaparana.org.br
Senha: mudar#123123


ID
105423334653428189338
Google-calendar

key=API_KEY
AIzaSyAQ8CeK6KwW3UJ-xsVTCR1Wha6z2XwI_uk



No Google Cloud Console, você não vai "encontrar" um arquivo .json pronto, mas sim gerar e baixar esse arquivo ao criar uma chave para a sua conta de serviço.
Siga o passo a passo exato de onde clicar dentro do painel do Google Cloud para gerar e baixar esse arquivo:

1. Criar o projeto e ativar a API

• Criar projeto: Acesse o Google Cloud Console, clique no seletor de projetos no topo esquerdo (ao lado do logotipo do Google Cloud) e clique em Novo projeto. Dê um nome e clique em Criar.
• Ativar a API: No menu lateral esquerdo (ícone de três linhas ☰), vá em APIs e serviços > Biblioteca. Pesquise por Google Calendar API, clique nela e depois no botão Ativar.

2. Criar a conta de serviço e baixar o arquivo .json

• Acessar Credenciais: No menu lateral esquerdo (☰), vá em APIs e serviços > Credenciais (ou acesse diretamente IAM e administrador > Contas de serviço).
• Criar Conta de Serviço: Clique em + Criar credenciais no topo e escolha Conta de serviço. Preencha um nome qualquer para ela, clique em Criar e continuar e depois em Concluir.
• Gerar e baixar o .json:
	• Na lista de Contas de serviço (na parte inferior da tela de Credenciais), clique sobre o e-mail da conta de serviço que você acabou de criar (ele termina com @...iam.gserviceaccount.com). Copie esse e-mail, pois você vai precisar dele no passo seguinte.
	• Na tela da conta, clique na aba Chaves (no menu superior).
	• Clique em Adicionar chave > Criar nova chave.
	• Selecione a opção JSON e clique em Criar.
	• O arquivo .json será gerado e baixado automaticamente para a pasta Downloads do seu computador.

3. Compartilhar a Agenda Google

• Abra o seu Google Agenda no navegador.
• Na barra lateral esquerda, passe o mouse sobre a agenda que deseja usar, clique nos três pontinhos (⋮) e escolha Configurações e compartilhamento.
• Role até a seção Compartilhar com pessoas ou grupos específicos e clique em + Adicionar pessoas e grupos.
• Cole o e-mail da conta de serviço que você copiou no passo 2.
• Em Permissões, selecione Fazer alterações nos eventos e clique em Enviar.
• Na mesma tela de configurações, role um pouco mais para baixo até Integrar agenda para copiar o ID da agenda (geralmente é o seu próprio e-mail ou um código terminado em @://google.com).
Depois disso, basta pegar o arquivo .json que foi para a sua pasta Downloads, movê-lo para a pasta dados/ do seu sistema e colar o ID da agenda no seu painel.
Você já conseguiu criar o projeto no Google Cloud ou travou em alguma tela específica do menu?
