import { IBasicRequestService } from '@/service/common/request';
import { Container } from 'typedi';
import { RequestHelper } from '@/service/request/common/request';
import { DocumentService } from './../../index';
import {
  FeishuBackendServiceConfig,
  FeishuUserInfoResponse,
  FeishuCompleteStatus,
  FeishuCreateDocumentRequest,
  FeishuTokenResponse,
} from './interface';
import md5 from '@web-clipper/shared/lib/md5';
import localeService from '@/common/locales';

const OPEN_API = 'https://open.feishu.cn';

export default class FeishuDocumentService implements DocumentService {
  private request: RequestHelper;
  private userInfo?: any;
  private config: FeishuBackendServiceConfig;
  
  constructor(config: FeishuBackendServiceConfig) {
    this.config = config;
    this.request = new RequestHelper({
      baseURL: OPEN_API,
      headers: {
        'Content-Type': 'application/json',
      },
      request: Container.get(IBasicRequestService),
      interceptors: {
        response: (response: any) => {
          if (response.code !== 0) {
            throw new Error(response.msg || 'Feishu API Error');
          }
          return response.data;
        },
      },
    });
  }

  getId = () => md5(this.config.workerUrl);

  refreshToken = async (info: FeishuBackendServiceConfig): Promise<FeishuBackendServiceConfig> => {
      if (!info.refreshToken || !info.workerUrl) {
          throw new Error('Missing refresh token or worker url');
      }
      const workerRefreshUrl = `${info.workerUrl.replace(/\/$/, '')}/refresh`;
      
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
          expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 7200)
      };
  }

  private getAccessToken = async () => {
    // Check expiration
    if (this.config.expiresAt && Date.now() / 1000 > this.config.expiresAt - 300) {
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

  private requestWithToken = async <T>(url: string, method: 'GET' | 'POST', data?: any) => {
    const token = await this.getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
    };

    if (method === 'GET') {
      return this.request.get<T>(url, { headers });
    } else {
      return this.request.post<T>(url, data, { headers });
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

