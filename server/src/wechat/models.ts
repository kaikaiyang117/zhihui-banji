export interface ILinkCredentials {
  bot_token: string;
  base_url: string;
  account_id: string;
  ilink_user_id: string;
}

export interface IncomingText {
  message_id: string;
  from_user_id: string;
  to_user_id: string;
  context_token: string;
  text: string;
}
