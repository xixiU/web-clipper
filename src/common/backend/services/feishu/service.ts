import { DocumentService } from './../../index';
import {
  FeishuBackendServiceConfig,
  FeishuUserInfoResponse,
  FeishuCompleteStatus,
  FeishuCreateDocumentRequest,
} from './interface';
import md5 from '@web-clipper/shared/lib/md5';

const OPEN_API = 'https://open.feishu.cn';

export default class FeishuDocumentService implements DocumentService {
  private userInfo?: any;
  private config: FeishuBackendServiceConfig;

  constructor(config: FeishuBackendServiceConfig) {
    this.config = config;
  }

  getId = () => md5(this.config.workerUrl);

  refreshToken = async (info: FeishuBackendServiceConfig): Promise<FeishuBackendServiceConfig> => {
    console.log('Feishu Refresh Token Called', {
      hasRefreshToken: !!info.refreshToken,
      workerUrl: info.workerUrl
    });
    if (!info.refreshToken || !info.workerUrl) {
      throw new Error('Missing refresh token or worker url');
    }
    const workerUrl = info.workerUrl.trim();
    const workerRefreshUrl = `${workerUrl.replace(/\/$/, '')}/refresh`;
    console.log('Feishu Refresh URL:', workerRefreshUrl);

    try {
      const response = await fetch(workerRefreshUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: info.refreshToken })
      });

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error);
      }

      return {
        ...info,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 7200)
      };
    } catch (e: any) {
      console.error('RefreshToken Error:', e);
      throw new Error(`Failed to refresh token: ${e.message}`);
    }
  }

  private getAccessToken = async () => {
    // Check expiration
    const expiresAt = Number(this.config.expiresAt);
    const now = Date.now() / 1000;
    const shouldRefresh = expiresAt && now > expiresAt - 300;

    console.log('Feishu GetAccessToken:', {
      expiresAt,
      now,
      shouldRefresh,
      accessToken: this.config.accessToken ? 'exists' : 'missing'
    });

    if (shouldRefresh) {
      // Token expired or about to expire (5 mins buffer)
      try {
        const newConfig = await this.refreshToken(this.config);
        this.config = newConfig;
        // Note: In a real app, we should persist this new config back to storage.
        // But DocumentService interface doesn't easily support saving back config unless called by upper layer.
        // However, typical usage is: upper layer checks if `refreshToken` method exists, call it, and save result.
        // Current Clipper architecture might not auto-save refreshed token easily.
        // We'll rely on in-memory update for this session. 
        // If the architecture supports `refreshToken` hook (interface line 81), it will work.
      } catch (e) {
        console.error('Refresh token failed', e);
        throw new Error('Session expired, please login again via Worker.');
      }
    }
    return this.config.accessToken;
  };

  private requestWithToken = async <T>(path: string, method: 'GET' | 'POST', data?: any) => {
    const token = await this.getAccessToken();
    const url = `${OPEN_API}${path}`;
    // Aggressively clean token: remove all whitespace including internal newlines
    const cleanToken = token.replace(/\s+/g, '');

    console.log('Feishu Request:', {
      url,
      method,
      tokenLength: cleanToken.length,
      tokenPreview: `${cleanToken.substring(0, 10)}...${cleanToken.substring(cleanToken.length - 5)}`,
      cleanToken: cleanToken
    });

    try {
      const headers = new Headers({
        'Authorization': `Bearer ${cleanToken}`,
      });

      if (method === 'POST') {
        headers.append('Content-Type', 'application/json');
      }

      const options: RequestInit = {
        method,
        headers,
      };

      if (method === 'POST' && data) {
        options.body = JSON.stringify(data);
      }

      const response = await fetch(url, options);
      const json = await response.json();

      if (json.code !== 0) {
        console.error('Feishu API Error:', json);
        throw new Error(json.msg || `Feishu API Error code: ${json.code}`);
      }

      return json.data as T;
    } catch (e: any) {
      console.error('Feishu Request Failed:', e);
      // Explicitly catch Headers error
      if (e.message && e.message.includes('Headers')) {
        throw new Error(`Invalid Token Format: Contains illegal characters. Length: ${cleanToken.length}`);
      }
      throw e;
    }
  };

  getUserInfo = async () => {
    if (!this.userInfo) {
      // Get User Info
      // Endpoint: GET https://open.feishu.cn/open-apis/authen/v1/user_info
      this.userInfo = await this.requestWithToken<FeishuUserInfoResponse['data']>('/open-apis/authen/v1/user_info', 'GET');
    }
    const { avatar_url, name, en_name } = this.userInfo;
    return {
      avatar: avatar_url,
      name: name || en_name,
      homePage: 'https://www.feishu.cn/drive/home/',
      description: 'Feishu User',
    };
  };

  getRepositories = async () => {
    // List "My Space" root folder children?
    // User Access Token allows access to user's files.
    // Let's just return a "Root" repository which represents "My Space".
    // Or we can list folders in root.

    // For User Identity, we can use Explorer API
    try {
      const rootMeta = await this.requestWithToken<any>('/open-apis/drive/explorer/v2/root_folder/meta', 'GET');
      return [{
        id: rootMeta.token,
        name: '我的空间 (My Space)',
        groupId: 'me',
        groupName: 'Personal',
      }];
    } catch (e) {
      return [{
        id: 'root',
        name: '我的空间 (My Space)',
        groupId: 'me',
        groupName: 'Personal',
      }];
    }
  };

  createDocument = async (info: FeishuCreateDocumentRequest): Promise<FeishuCompleteStatus> => {
    const { title, content, repositoryId } = info;

    // 1. Create Document
    // Using User Access Token, folder_token can be root token.
    const createRes = await this.requestWithToken<any>('/open-apis/docx/v1/documents', 'POST', {
      folder_token: repositoryId,
      title: title,
    });

    const documentId = createRes.document.document_id;

    // 2. Write Content
    const blocks = [
      {
        block_type: 2, // Text
        text: {
          elements: [
            {
              text_run: {
                content: content
              }
            }
          ]
        }
      }
    ];

    await this.requestWithToken<any>(`/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, 'POST', {
      children: blocks,
      index: -1,
    });

    return {
      href: `https://feishu.cn/docx/${documentId}`,
      repositoryId,
      documentId,
    };
  };
}

