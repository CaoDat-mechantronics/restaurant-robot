class GeminiRobotLive {
  constructor({
    apiBase,
    getToken,
    getRobotNumber,
    onState = () => {},
    onTranscript = () => {},
    onToolResult = () => {},
    onDebug = () => {},
    onLevel = () => {}
  }) {
    this.apiBase = apiBase.replace(/\/+$/, "");

    this.getToken = getToken;
    this.getRobotNumber = getRobotNumber;

    this.onState = onState;
    this.onTranscript = onTranscript;
    this.onToolResult = onToolResult;
    this.onDebug = onDebug;

    this.socket = null;
    this.ready = false;
    this.mic = false;

    // Kết quả check-food gần nhất. prepare_delivery chỉ được tạo từ dữ liệu này.
    this.lastFoodCheck = null;

    this.audio = new RobotAudio({
      onLevel,
      onError: (error) => {
        this.onDebug("AUDIO ERROR: " + error.message);
      }
    });
  }

  // =========================================================
  // SYSTEM INSTRUCTION
  // =========================================================

  systemInstruction() {
    return `
Bạn là trợ lý điều phối robot phục vụ trong nhà hàng.

Luôn trả lời bằng tiếng Việt, ngắn gọn, rõ ràng và lịch sự.

QUY TẮC BẮT BUỘC:

1. Khi người dùng yêu cầu mang/giao món tới một bàn,
   phải xác định rõ tên món và số bàn.

2. LUÔN gọi function check_table_food trước khi xác nhận món tồn tại.

3. Tuyệt đối không tự bịa item_id, tên món, số bàn, Line, hướng rẽ, stop_index hoặc trạng thái món.

4. Nếu check_table_food trả found=false hoặc deliverable=false:
   - giải thích ngắn gọn theo đúng tool result;
   - KHÔNG gọi prepare_delivery.

5. Nếu found=true và deliverable=true:
   - đọc lại tên món, số bàn, Line và hướng rẽ;
   - hỏi người dùng xác nhận trước khi nhận nhiệm vụ.

6. CHỈ sau khi người dùng xác nhận rõ ràng như "đồng ý", "xác nhận", "giao đi", "ok"
   mới gọi prepare_delivery.

7. prepare_delivery KHÔNG cho robot chạy ngay. Nó chỉ chuyển frontend sang trạng thái:
   "đã nhận nhiệm vụ - chờ đặt món lên robot".

8. Sau prepare_delivery thành công, nói rõ:
   - nhiệm vụ đã được nhận;
   - hãy đặt món lên robot;
   - robot chỉ bắt đầu dispatch khi cảm biến IR5 báo đã có món.

9. Nếu người dùng đổi món hoặc đổi bàn trước khi xác nhận, phải gọi check_table_food lại.

10. Route do backend quyết định. Không tự tính hoặc sửa route.
`;
  }

  // =========================================================
  // GEMINI TOOLS
  // =========================================================

  tools() {
    return [
      {
        functionDeclarations: [
          {
            name: "check_table_food",
            description:
              "Kiểm tra trong dữ liệu nhà hàng xem một bàn có món người quản lý yêu cầu hay không. Phải gọi trước khi nhận nhiệm vụ giao món.",
            parameters: {
              type: "OBJECT",
              properties: {
                table_number: {
                  type: "INTEGER",
                  description: "Số bàn từ 1 đến 10."
                },
                food_name: {
                  type: "STRING",
                  description: "Tên món ăn người dùng yêu cầu."
                }
              },
              required: ["table_number", "food_name"]
            }
          },
          {
            name: "prepare_delivery",
            description:
              "Sau khi người dùng xác nhận, ghi nhận nhiệm vụ giao món ở frontend và chờ IR5 phát hiện món. Tool này không dispatch database và không publish MQTT.",
            parameters: {
              type: "OBJECT",
              properties: {
                item_id: {
                  type: "INTEGER",
                  description: "ID món chính xác do check_table_food trả về."
                },
                table_number: {
                  type: "INTEGER",
                  description: "Số bàn chính xác do check_table_food trả về."
                }
              },
              required: ["item_id", "table_number"]
            }
          }
        ]
      }
    ];
  }

  // =========================================================
  // DECODE WEBSOCKET MESSAGE
  // =========================================================

  async decodeWebSocketMessage(data) {
    let text;

    if (typeof data === "string") {
      text = data;
    }

    else if (data instanceof Blob) {
      text = await data.text();
    }

    else if (data instanceof ArrayBuffer) {
      text = new TextDecoder("utf-8").decode(
        new Uint8Array(data)
      );
    }

    else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder("utf-8").decode(data);
    }

    else {
      throw new Error(
        "Unsupported WebSocket data type: " +
        Object.prototype.toString.call(data)
      );
    }

    return JSON.parse(text);
  }

  // =========================================================
  // CONNECT GEMINI LIVE
  // =========================================================

  async connect() {
    if (
      this.socket &&
      this.socket.readyState === WebSocket.OPEN &&
      this.ready
    ) {
      return;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch (_) {}

      this.socket = null;
      this.ready = false;
    }

    this.onState("connecting");

    const info = await this.getToken();

    if (!info?.token) {
      throw new Error(
        "Backend không trả về Gemini ephemeral token."
      );
    }

    if (!info?.model) {
      throw new Error(
        "Backend không trả về Gemini model."
      );
    }

    const url =
      `${window.APP_CONFIG.GEMINI_WS_BASE}` +
      `?access_token=${encodeURIComponent(info.token)}`;

    this.onDebug(
      `Opening Gemini Live model=${info.model}`
    );

    await new Promise((resolve, reject) => {
      let settled = false;

      const resolveOnce = () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      const rejectOnce = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };

      const ws = new WebSocket(url);

      // Chrome sẽ nhận binary frame dưới dạng ArrayBuffer.
      ws.binaryType = "arraybuffer";

      this.socket = ws;

      const setupTimer = setTimeout(() => {
        this.ready = false;

        rejectOnce(
          new Error(
            "Gemini không trả setupComplete trong 15 giây."
          )
        );

        try {
          ws.close(
            1000,
            "setup timeout"
          );
        } catch (_) {}
      }, 15000);

      // -----------------------------------------------------
      // OPEN
      // -----------------------------------------------------

      ws.onopen = () => {
        this.onDebug(
          "Gemini WebSocket opened"
        );

        const setupMessage = {
          setup: {
            model:
              `models/${info.model}`,

            generationConfig: {
              responseModalities: [
                "AUDIO"
              ]
            },

            systemInstruction: {
              parts: [
                {
                  text:
                    this.systemInstruction()
                }
              ]
            },

            tools:
              this.tools(),

            inputAudioTranscription: {},

            outputAudioTranscription: {}
          }
        };

        this.onDebug(
          "→ SETUP " +
          JSON.stringify(setupMessage)
            .slice(0, 1800)
        );

        ws.send(
          JSON.stringify(setupMessage)
        );
      };

      // -----------------------------------------------------
      // MESSAGE
      // -----------------------------------------------------

      ws.onmessage = async (event) => {
        let message;

        try {
          message =
            await this.decodeWebSocketMessage(
              event.data
            );
        } catch (error) {
          this.onDebug(
            "Gemini message decode error: " +
            error.message
          );

          return;
        }

        this.onDebug(
          "← " +
          JSON.stringify(message)
            .slice(0, 1800)
        );

        if (message.setupComplete) {
          clearTimeout(setupTimer);

          this.ready = true;

          this.onState(
            "ready"
          );

          this.onDebug(
            "Gemini setupComplete ✓"
          );

          resolveOnce();

          return;
        }

        try {
          await this.handle(message);
        } catch (error) {
          this.onDebug(
            "Gemini handle error: " +
            error.message
          );
        }
      };

      // -----------------------------------------------------
      // ERROR
      // -----------------------------------------------------

      ws.onerror = () => {
        clearTimeout(setupTimer);

        this.ready = false;

        this.onState(
          "error"
        );

        rejectOnce(
          new Error(
            "Gemini WebSocket error."
          )
        );
      };

      // -----------------------------------------------------
      // CLOSE
      // -----------------------------------------------------

      ws.onclose = (event) => {
        clearTimeout(setupTimer);

        const wasReady =
          this.ready;

        this.ready = false;
        this.mic = false;

        this.audio.stop();

        this.onDebug(
          `CLOSE ${event.code} ${event.reason || ""}`
        );

        this.onState(
          "closed"
        );

        if (!wasReady) {
          rejectOnce(
            new Error(
              `Gemini đóng kết nối: ` +
              `${event.code} ${event.reason || ""}`
            )
          );
        }
      };
    });
  }

  // =========================================================
  // RECEIVE GEMINI SERVER MESSAGE
  // =========================================================

  async handle(message) {
    const content =
      message.serverContent;

    if (content?.interrupted) {
      this.audio.stopPlayback();

      this.onState(
        this.mic
          ? "listening"
          : "ready"
      );
    }

    if (
      content
        ?.inputTranscription
        ?.text
    ) {
      this.onTranscript(
        "user",
        content.inputTranscription.text
      );
    }

    if (
      content
        ?.outputTranscription
        ?.text
    ) {
      this.onTranscript(
        "assistant",
        content.outputTranscription.text
      );
    }

    const parts =
      content
        ?.modelTurn
        ?.parts || [];

    for (const part of parts) {
      if (
        part.inlineData &&
        part.inlineData.data
      ) {
        this.onState(
          "speaking"
        );

        await this.audio.play(
          part.inlineData.data,
          part.inlineData.mimeType ||
            "audio/pcm;rate=24000"
        );
      }

      if (part.text) {
        this.onDebug(
          "MODEL TEXT: " +
          part.text
        );
      }
    }

    if (content?.turnComplete) {
      this.onState(
        this.mic
          ? "listening"
          : "ready"
      );
    }

    if (message.toolCall) {
      await this.handleTool(
        message.toolCall
      );
    }

    if (message.goAway) {
      this.onDebug(
        "GO_AWAY " +
        JSON.stringify(message.goAway)
      );
    }

    if (message.sessionResumptionUpdate) {
      this.onDebug(
        "SESSION_RESUMPTION " +
        JSON.stringify(
          message.sessionResumptionUpdate
        )
      );
    }
  }

  // =========================================================
  // HANDLE GEMINI FUNCTION CALL
  // =========================================================

  async handleTool(toolCall) {
    const responses = [];

    for (
      const functionCall
      of toolCall.functionCalls || []
    ) {
      this.onState(
        "thinking"
      );

      this.onDebug(
        `TOOL CALL ${functionCall.name} ` +
        JSON.stringify(
          functionCall.args || {}
        )
      );

      let result;

      try {
        result =
          await this.execTool(
            functionCall.name,
            functionCall.args || {}
          );
      } catch (error) {
        result = {
          success: false,
          error:
            error.message
        };
      }

      this.onToolResult(
        functionCall.name,
        result
      );

      responses.push({
        name:
          functionCall.name,

        id:
          functionCall.id,

        response: {
          result
        }
      });
    }

    if (!responses.length) {
      return;
    }

    this.send({
      toolResponse: {
        functionResponses:
          responses
      }
    });
  }

  // =========================================================
  // EXECUTE TOOLS THROUGH FASTAPI
  // =========================================================

  async execTool(
    name,
    args
  ) {
    if (
      name ===
      "check_table_food"
    ) {
      const result = await this.authFetch(
        "/robot-ai/check-food",
        {
          method: "POST",
          body: JSON.stringify({
            table_number: Number(args.table_number),
            food_name: String(args.food_name || "")
          })
        }
      );

      this.lastFoodCheck = result;
      return result;
    }

    if (
      name ===
      "prepare_delivery"
    ) {
      const checked = this.lastFoodCheck;

      if (!checked?.found || !checked?.deliverable || !checked?.item) {
        throw new Error(
          "Chưa có kết quả check_table_food hợp lệ để nhận nhiệm vụ."
        );
      }

      const itemId = Number(args.item_id);
      const tableNumber = Number(args.table_number);
      const checkedItemId = Number(checked.item.id);
      const checkedTable = Number(checked.table_number);

      if (itemId !== checkedItemId || tableNumber !== checkedTable) {
        throw new Error(
          "item_id hoặc table_number không khớp kết quả check_table_food gần nhất."
        );
      }

      return {
        success: true,
        accepted: true,
        waiting_for_food: true,
        item_id: checkedItemId,
        table_number: checkedTable,
        table: checkedTable,
        food_name: checked.item.food_name,
        route: checked.route,
        message: "Đã nhận nhiệm vụ. Đang chờ IR5 xác nhận món đã được đặt lên robot."
      };
    }

    throw new Error(
      "Unknown Gemini tool: " + name
    );
  }

  // =========================================================
  // AUTH FETCH
  // =========================================================

  async authFetch(
    path,
    options = {}
  ) {
    const token =
      localStorage.getItem(
        "restaurant_access_token"
      );

    if (!token) {
      const error =
        new Error(
          "Chưa đăng nhập backend."
        );

      error.status = 401;

      throw error;
    }

    const response =
      await fetch(
        this.apiBase + path,
        {
          ...options,

          headers: {
            "Content-Type":
              "application/json",

            "Authorization":
              `Bearer ${token}`,

            ...(options.headers || {})
          }
        }
      );

    const data =
      await response
        .json()
        .catch(() => ({}));

    if (!response.ok) {
      const error =
        new Error(
          data.detail ||
          data.message ||
          `HTTP ${response.status}`
        );

      error.status =
        response.status;

      error.data =
        data;

      throw error;
    }

    return data;
  }

  // =========================================================
  // START MICROPHONE
  // =========================================================

  async startMic() {
    await this.connect();

    if (this.mic) {
      return;
    }

    if (
      !this.ready ||
      this.socket
        ?.readyState
        !== WebSocket.OPEN
    ) {
      throw new Error(
        "Gemini chưa sẵn sàng."
      );
    }

    this.mic =
      true;

    this.onState(
      "listening"
    );

    await this.audio.start(
      (pcmBuffer) => {
        if (
          !this.ready ||
          this.socket
            ?.readyState
            !== WebSocket.OPEN
        ) {
          return;
        }

        this.send({
          realtimeInput: {
            audio: {
              data:
                this.audio.toB64(
                  pcmBuffer
                ),

              mimeType:
                "audio/pcm;rate=16000"
            }
          }
        });
      }
    );
  }

  // =========================================================
  // STOP MICROPHONE
  // =========================================================

  stopMic() {
    if (!this.mic) {
      return;
    }

    this.mic =
      false;

    this.audio.stop();

    if (
      this.ready &&
      this.socket
        ?.readyState
        === WebSocket.OPEN
    ) {
      this.send({
        realtimeInput: {
          audioStreamEnd:
            true
        }
      });
    }

    this.onState(
      "ready"
    );
  }

  // =========================================================
  // SEND DEBUG TEXT
  // =========================================================

  async sendText(text) {
    const value =
      String(text || "")
        .trim();

    if (!value) {
      return;
    }

    await this.connect();

    if (!this.ready) {
      throw new Error(
        "Gemini chưa setup xong."
      );
    }

    this.onTranscript(
      "user",
      value
    );

    this.send({
      clientContent: {
        turns: [
          {
            role:
              "user",

            parts: [
              {
                text:
                  value
              }
            ]
          }
        ],

        turnComplete:
          true
      }
    });
  }

  // =========================================================
  // SEND JSON TO GEMINI
  // =========================================================

  send(object) {
    if (
      !this.socket ||
      this.socket
        .readyState
        !== WebSocket.OPEN
    ) {
      throw new Error(
        "Gemini WebSocket chưa mở."
      );
    }

    this.onDebug(
      "→ " +
      JSON.stringify(object)
        .slice(0, 1600)
    );

    this.socket.send(
      JSON.stringify(object)
    );
  }

  // =========================================================
  // CLOSE SESSION
  // =========================================================

  close() {
    if (this.mic) {
      this.stopMic();
    }

    this.audio.stopPlayback();

    if (this.socket) {
      try {
        this.socket.close(
          1000,
          "user close"
        );
      } catch (_) {}
    }

    this.socket =
      null;

    this.ready =
      false;

    this.mic =
      false;
  }
}

window.GeminiRobotLive =
  GeminiRobotLive;