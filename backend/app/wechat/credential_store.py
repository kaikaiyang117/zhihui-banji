# -*- coding: utf-8 -*-
"""微信凭证存储：环境变量优先，系统凭据库作为持久化后备。"""
from __future__ import annotations

import json
import os

from .models import ILinkCredentials


class CredentialError(Exception):
    """凭证不可用或系统凭据库不可用。"""


class CredentialStore:
    SERVICE = 'MeimeiWorkbench/WeChat'
    ACCOUNT = 'default'

    def load(self) -> ILinkCredentials | None:
        token = os.environ.get('MEIMEI_WECHAT_BOT_TOKEN', '').strip()
        if token:
            return ILinkCredentials(
                bot_token=token,
                base_url=os.environ.get('MEIMEI_WECHAT_BASE_URL', 'https://ilinkai.weixin.qq.com').rstrip('/'),
                account_id=os.environ.get('MEIMEI_WECHAT_ACCOUNT_ID', ''),
                ilink_user_id=os.environ.get('MEIMEI_WECHAT_USER_ID', ''),
            )
        payload = self._read_keyring()
        if not payload or not payload.get('bot_token'):
            return None
        return ILinkCredentials(
            bot_token=str(payload['bot_token']),
            base_url=str(payload.get('base_url') or 'https://ilinkai.weixin.qq.com').rstrip('/'),
            account_id=str(payload.get('account_id') or ''),
            ilink_user_id=str(payload.get('ilink_user_id') or ''),
        )

    def save(self, credentials: ILinkCredentials):
        keyring = self._keyring()
        try:
            keyring.set_password(self.SERVICE, self.ACCOUNT, json.dumps({
                'bot_token': credentials.bot_token,
                'base_url': credentials.base_url,
                'account_id': credentials.account_id,
                'ilink_user_id': credentials.ilink_user_id,
            }, ensure_ascii=False))
        except Exception as exc:  # pragma: no cover - depends on OS credential backend
            raise CredentialError(f'系统凭据库保存失败：{exc}') from exc

    def clear(self):
        keyring = self._keyring()
        try:
            keyring.delete_password(self.SERVICE, self.ACCOUNT)
        except Exception as exc:
            message = str(exc).lower()
            if 'not found' not in message and '不存在' not in message:
                raise CredentialError(f'系统凭据库清理失败：{exc}') from exc

    def _read_keyring(self) -> dict:
        try:
            raw = self._keyring().get_password(self.SERVICE, self.ACCOUNT)
        except Exception:
            return {}
        if not raw:
            return {}
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _keyring():
        try:
            import keyring
        except ImportError as exc:  # pragma: no cover - dependency is optional in isolated tests
            raise CredentialError('未安装 keyring，开发环境请设置 MEIMEI_WECHAT_BOT_TOKEN') from exc
        return keyring
