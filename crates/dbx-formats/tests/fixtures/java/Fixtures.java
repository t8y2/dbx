import java.io.*;
import java.util.*;
public class Fixtures {
  enum Color { RED }
  static class Base implements Serializable { private static final long serialVersionUID=1; int base=7; }
  static class Child extends Base { private static final long serialVersionUID=1; String name="Ada"; Object self=this; long large=Long.MAX_VALUE; }
  static void emit(String name, Object value) throws Exception {
    ByteArrayOutputStream b=new ByteArrayOutputStream();
    try(ObjectOutputStream o=new ObjectOutputStream(b)) { o.writeObject(value); }
    System.out.println(name+" "+Base64.getEncoder().encodeToString(b.toByteArray()));
  }
  public static void main(String[] args) throws Exception {
    emit("string", "sometext"); emit("unicode", "A\0你好😀"); emit("child", new Child());
    HashMap<String,Object> map=new HashMap<>(); map.put("self",map); emit("self-map",map);
    emit("int-array", new int[]{-2,0,42}); emit("long-array",new long[]{Long.MIN_VALUE,Long.MAX_VALUE});
    Child c=new Child(); emit("references",new Object[]{c,c,null}); emit("enum", Color.RED);
    emit("list",new ArrayList<>(Arrays.asList("one",42))); emit("deque",new ArrayDeque<>(Arrays.asList("one","two")));
    emit("set",new HashSet<>(Arrays.asList("one","two")));
    EnumMap<Color,String> em=new EnumMap<>(Color.class); em.put(Color.RED,"red"); emit("enum-map",em);
    emit("bytes",new byte[]{-1,0,127}); emit("booleans",new boolean[]{true,false});
  }
}
