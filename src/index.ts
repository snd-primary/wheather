// Model Context Protocol (MCP) サーバー実装をインポート
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// 標準入出力を使ったサーバー通信のためのトランスポートをインポート
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// 入力バリデーション用のライブラリ
import { z } from "zod";

// 米国気象サービスAPIのベースURL
const NWS_API_BASE = "https://api.weather.gov";
// APIリクエスト時に使用するUser-Agent（アプリケーション識別子）
const USER_AGENT = "weather-app/1.0";

// MCP（Model Context Protocol）サーバーのインスタンスを作成
// このサーバーはAIモデルと通信するためのインターフェースを提供
const server = new McpServer({
	name: "weather", // サーバー名
	version: "1.0.0", // バージョン情報
	capabilities: {
		// このサーバーが提供する機能
		resources: {}, // リソース定義（今回は空）
		tools: {}, // ツール定義（後で追加）
	},
});

/**
 * 米国気象サービス（NWS）APIにリクエストを送信するためのヘルパー関数
 * @param url リクエスト先のURL
 * @returns JSONレスポンスをパースした結果、またはエラー時はnull
 */
async function makeNWSRequest<T>(url: string): Promise<T | null> {
	// APIリクエストに必要なヘッダー情報を設定
	const headers = {
		"User-Agent": USER_AGENT,
		Accept: "application/geo+json", // 地理情報を含むJSONフォーマットを要求
	};

	try {
		// fetch APIを使用してHTTPリクエストを実行
		const response = await fetch(url, { headers });
		// レスポンスが成功（200-299のステータスコード）でない場合はエラーをスロー
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		// レスポンスをJSONとしてパースして返す
		return (await response.json()) as T;
	} catch (error) {
		// エラーが発生した場合はコンソールにエラー内容を出力しnullを返す
		console.error("Error making NWS request:", error);
		return null;
	}
}

// 気象アラート情報の単一特性（feature）を表すインターフェース
interface AlertFeature {
	properties: {
		event?: string; // アラートの種類（例：洪水警報、強風注意報など）
		areaDesc?: string; // アラート対象地域の説明
		severity?: string; // 重大度（例：Severe, Moderate, Minorなど）
		status?: string; // 状態（例：Actual, Testなど）
		headline?: string; // 見出し（簡潔な説明）
	};
}

/**
 * アラート情報を読みやすい形式にフォーマットする関数
 * @param feature アラート情報のfeatureオブジェクト
 * @returns フォーマットされたアラートテキスト
 */
function formatAlert(feature: AlertFeature): string {
	const props = feature.properties;
	// アラート情報を整形して返す
	return [
		`Event: ${props.event || "Unknown"}`,
		`Area: ${props.areaDesc || "Unknown"}`,
		`Severity: ${props.severity || "Unknown"}`,
		`Status: ${props.status || "Unknown"}`,
		`Headline: ${props.headline || "No headline"}`,
		"---", // 区切り線
	].join("\n");
}

// 天気予報の一つの期間を表すインターフェース
interface ForecastPeriod {
	name?: string; // 予報期間の名前（例：Today, Tonight, Mondayなど）
	temperature?: number; // 気温
	temperatureUnit?: string; // 気温の単位（例：F, Cなど）
	windSpeed?: string; // 風速
	windDirection?: string; // 風向き
	shortForecast?: string; // 簡潔な予報内容
}

// アラートAPIからのレスポンスを表すインターフェース
interface AlertsResponse {
	features: AlertFeature[]; // アラート情報の配列
}

// 地点情報APIからのレスポンスを表すインターフェース
interface PointsResponse {
	properties: {
		forecast?: string; // 予報情報を取得するためのURL
	};
}

// 予報APIからのレスポンスを表すインターフェース
interface ForecastResponse {
	properties: {
		periods: ForecastPeriod[]; // 予報期間の配列
	};
}

// 「get-alerts」ツールの登録 - 指定した州の気象アラート情報を取得
server.tool(
	"get-alerts", // ツール名
	"Get weather alerts for a state", // ツールの説明
	{
		// 入力パラメータの定義（Zodスキーマを使用）
		state: z.string().length(2).describe("Two-letter state code (e.g. CA, NY)"),
	},
	// ツールの実装（非同期関数）
	async ({ state }) => {
		// 州コードを大文字に変換
		const stateCode = state.toUpperCase();
		// アラート情報を取得するAPIエンドポイントのURLを構築
		const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
		// APIからアラート情報を取得
		const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

		// データ取得に失敗した場合はエラーメッセージを返す
		if (!alertsData) {
			return {
				content: [
					{
						type: "text",
						text: "Failed to retrieve alerts data",
					},
				],
			};
		}

		// アラート情報の配列を取得（空の場合は空配列をデフォルト値として使用）
		const features = alertsData.features || [];
		// アラートが存在しない場合はその旨を伝えるメッセージを返す
		if (features.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No active alerts for ${stateCode}`,
					},
				],
			};
		}

		// 各アラートをフォーマットして配列に格納
		const formattedAlerts = features.map(formatAlert);
		// 最終的なテキストを構築
		const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join(
			"\n"
		)}`;

		// テキスト形式のレスポンスを返す
		return {
			content: [
				{
					type: "text",
					text: alertsText,
				},
			],
		};
	}
);

// 「get-forecast」ツールの登録 - 指定した座標の天気予報を取得
server.tool(
	"get-forecast", // ツール名
	"Get weather forecast for a location", // ツールの説明
	{
		// 入力パラメータの定義（Zodスキーマを使用）
		latitude: z.number().min(-90).max(90).describe("Latitude of the location"),
		longitude: z
			.number()
			.min(-180)
			.max(180)
			.describe("Longitude of the location"),
	},
	// ツールの実装（非同期関数）
	async ({ latitude, longitude }) => {
		// まず、座標からNWSグリッドポイント情報を取得
		const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(
			4
		)},${longitude.toFixed(4)}`;
		const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

		// データ取得に失敗した場合はエラーメッセージを返す
		if (!pointsData) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
					},
				],
			};
		}

		// グリッドポイントデータから予報URLを取得
		const forecastUrl = pointsData.properties?.forecast;
		// 予報URLが存在しない場合はエラーメッセージを返す
		if (!forecastUrl) {
			return {
				content: [
					{
						type: "text",
						text: "Failed to get forecast URL from grid point data",
					},
				],
			};
		}

		// 予報URLから予報データを取得
		const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
		// データ取得に失敗した場合はエラーメッセージを返す
		if (!forecastData) {
			return {
				content: [
					{
						type: "text",
						text: "Failed to retrieve forecast data",
					},
				],
			};
		}

		// 予報期間の配列を取得（空の場合は空配列をデフォルト値として使用）
		const periods = forecastData.properties?.periods || [];
		// 予報期間が存在しない場合はその旨を伝えるメッセージを返す
		if (periods.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No forecast periods available",
					},
				],
			};
		}

		// 各予報期間をフォーマットして配列に格納
		const formattedForecast = periods.map((period: ForecastPeriod) =>
			[
				`${period.name || "Unknown"}:`,
				`Temperature: ${period.temperature || "Unknown"}°${
					period.temperatureUnit || "F"
				}`,
				`Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
				`${period.shortForecast || "No forecast available"}`,
				"---", // 区切り線
			].join("\n")
		);

		// 最終的なテキストを構築
		const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join(
			"\n"
		)}`;

		// テキスト形式のレスポンスを返す
		return {
			content: [
				{
					type: "text",
					text: forecastText,
				},
			],
		};
	}
);

/**
 * メイン関数 - プログラムのエントリーポイント
 * このコードは標準入出力を使用してMCPサーバーを起動する
 */
async function main() {
	// 標準入出力を使用するトランスポートを作成
	const transport = new StdioServerTransport();
	// サーバーをトランスポートに接続
	await server.connect(transport);
	// サーバー起動メッセージをエラー出力に表示
	console.error("Weather MCP Server running on stdio");
}

// メイン関数を実行し、エラーが発生した場合はエラーメッセージを表示してプログラムを終了
main().catch((error) => {
	console.error("Fatal error in main():", error);
	process.exit(1);
});
